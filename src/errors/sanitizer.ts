/**
 * Error sanitization for the JSON-RPC boundary.
 *
 * A stack trace or raw driver error returned to a client leaks file paths, schema
 * names, internal hostnames, and occasionally credentials embedded in a connection
 * string. The split is therefore asymmetric by design:
 *
 *   client   -> a stable code, a generic message, and an incident id
 *   operator -> the full error, correlated by that same incident id
 *
 * The deliberate exception is argument validation. Field paths and expected types are
 * exactly what a model needs to fix its own call, and withholding them converts a
 * single repair round into an unbounded retry loop. Field VALUES are still stripped,
 * because a rejected argument frequently contains the PII that made it invalid.
 */

import { randomUUID } from 'node:crypto';

export const RpcCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNAUTHORIZED: -32001,
  RATE_LIMITED: -32029,
} as const;

export type RpcCodeValue = (typeof RpcCode)[keyof typeof RpcCode];

export interface SanitizedError {
  code: RpcCodeValue;
  message: string;
  data?: Record<string, unknown>;
}

export interface OperatorLogEntry {
  incidentId: string;
  toolName?: string;
  code: RpcCodeValue;
  /** Message as the client will see it. */
  clientMessage: string;
  /** Unredacted internal message. Never leaves the log. */
  internalMessage: string;
  stack?: string;
  timestamp: string;
}

export interface SanitizerConfig {
  /**
   * Include an incident id in the client response.
   *
   * On by default: without a correlation handle, a user reporting "it failed" gives
   * an operator nothing to search for, and the generic message is otherwise a dead
   * end for both sides.
   */
  includeIncidentId?: boolean;
  /** Additional patterns to scrub from operator logs. */
  extraRedactions?: RegExp[];
  onOperatorLog?: (entry: OperatorLogEntry) => void;
}

export interface ValidationIssue {
  path: string;
  expected: string;
  message: string;
  /** Closest known key, when the issue looks like a typo. */
  suggestion?: string;
}

/**
 * Patterns scrubbed from operator logs.
 *
 * Applied to the LOG, not only the client response, because a log shipped to a
 * third-party aggregator is another egress point, and "internal" is not the same as
 * "private".
 */
const SECRET_PATTERNS: RegExp[] = [
  // Bearer and generic key-value secrets
  /\b(bearer\s+)[A-Za-z0-9._~+/-]{16,}={0,2}/gi,
  /\b(api[_-]?key|apikey|secret|token|password|passwd|pwd)\s*[:=]\s*\S+/gi,
  // Vendor key shapes
  /\bsk-[A-Za-z0-9]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Connection strings carry credentials in the authority component
  /\b[a-z][a-z0-9+.-]*:\/\/[^:\s/]+:[^@\s/]+@[^\s]+/gi,
  // JWTs
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

export class ErrorSanitizer {
  private readonly config: SanitizerConfig;
  private readonly patterns: RegExp[];

  constructor(config: SanitizerConfig = {}) {
    this.config = config;
    this.patterns = [...SECRET_PATTERNS, ...(config.extraRedactions ?? [])];
  }

  /**
   * Sanitize a thrown value from a tool handler.
   *
   * Returns the client-facing error and emits the operator entry as a side effect,
   * so the two cannot drift apart: there is no path that produces a generic client
   * message without recording what it actually was.
   */
  sanitizeHandlerError(
    error: unknown,
    context: { toolName: string; aborted?: boolean; timeoutMs?: number },
  ): SanitizedError {
    const incidentId = randomUUID().slice(0, 8);
    const internalMessage = error instanceof Error ? error.message : String(error);

    // A timeout is worth distinguishing from a generic failure, because the outcome
    // is UNKNOWN rather than failed: the handler may have completed its side effect
    // after the client stopped waiting.
    const clientMessage = context.aborted
      ? `Tool "${context.toolName}" exceeded its ${context.timeoutMs ?? 0}ms timeout. ` +
        'The operation may or may not have completed; verify state before retrying.'
      : `Tool "${context.toolName}" failed during execution.`;

    this.emitOperatorLog({
      incidentId,
      toolName: context.toolName,
      code: RpcCode.INTERNAL_ERROR,
      clientMessage,
      internalMessage,
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      timestamp: new Date().toISOString(),
    });

    return {
      code: RpcCode.INTERNAL_ERROR,
      message: clientMessage,
      ...(this.config.includeIncidentId !== false ? { data: { incidentId } } : {}),
    };
  }

  /**
   * Validation errors, which are intentionally detailed.
   *
   * Paths and expected types are returned; received values are not. "Unrecognized
   * key" alone tends to make a model drop the field rather than fix the spelling,
   * which is why a typo suggestion is included when one is available.
   */
  sanitizeValidationError(
    toolName: string,
    issues: readonly ValidationIssue[],
  ): SanitizedError {
    return {
      code: RpcCode.INVALID_PARAMS,
      message: `Arguments failed validation for "${toolName}".`,
      data: {
        issues: issues.map((issue) => ({
          path: issue.path,
          expected: issue.expected,
          message: this.redact(issue.message),
          ...(issue.suggestion !== undefined ? { suggestion: issue.suggestion } : {}),
        })),
      },
    };
  }

  /**
   * Permission denial.
   *
   * The reason IS returned, unlike an internal error. A denial is a deliberate policy
   * decision rather than a leak, and an agent told only "unauthorized" will keep
   * retrying the same forbidden call.
   */
  sanitizePermissionDenial(toolName: string, reason: string): SanitizedError {
    return {
      code: RpcCode.UNAUTHORIZED,
      message: reason,
      data: { toolName },
    };
  }

  sanitizeRateLimit(toolName: string, retryAfterMs: number): SanitizedError {
    return {
      code: RpcCode.RATE_LIMITED,
      message: `Rate limit exceeded for "${toolName}".`,
      // Machine-readable, so a client can wait the right amount instead of
      // hammering. Both units are given because clients disagree on which they read.
      data: { retryAfterMs, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) },
    };
  }

  sanitizeUnknownMethod(method: string): SanitizedError {
    return {
      code: RpcCode.METHOD_NOT_FOUND,
      // The method name is echoed because the client sent it, so this reveals
      // nothing it did not already know.
      message: `Method "${method}" is not supported by this server.`,
    };
  }

  /**
   * Scrub secrets from a string.
   *
   * Public because operator logs should be scrubbed too. A log shipped to a
   * third-party aggregator is an egress point, and treating "internal" as "private"
   * is how credentials end up in someone else's index.
   */
  redact(input: string): string {
    let output = input;

    for (const pattern of this.patterns) {
      // A fresh RegExp per call because global patterns carry lastIndex, and a
      // shared instance would skip matches on the second invocation.
      output = output.replace(new RegExp(pattern.source, pattern.flags), (match) => {
        // Preserve the key name and drop the value, so a log still says WHICH
        // credential appeared without saying what it was.
        const separatorIndex = match.search(/[:=]/);
        if (separatorIndex > 0 && separatorIndex < 40) {
          return `${match.slice(0, separatorIndex + 1)} [REDACTED]`;
        }
        return '[REDACTED]';
      });
    }

    return output;
  }

  private emitOperatorLog(entry: OperatorLogEntry): void {
    this.config.onOperatorLog?.({
      ...entry,
      internalMessage: this.redact(entry.internalMessage),
      ...(entry.stack !== undefined ? { stack: this.redact(entry.stack) } : {}),
    });
  }
}
