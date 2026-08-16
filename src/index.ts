/**
 * mcp-toolkit: build Model Context Protocol servers without the boilerplate.
 *
 * Two layers:
 *   Registry  -> validates registrations, derives JSON Schema, tracks per-tool health
 *   MCPServer -> transport, auth, rate limiting, MCP method dispatch
 *
 * Registry is the one worth using directly. It rejects bad registrations at
 * startup instead of at first call, and it derives schemas with
 * zod-to-json-schema rather than approximating them.
 */

import { z } from 'zod';

import { Registry, defineTool } from './core/registry';
import { MCPServer } from './server/mcp-server';

import type {
  ToolContext,
  ToolContent,
  ToolResult,
  ToolDefinition,
  RegisteredTool,
  ResourceDefinition,
} from './core/registry';
import type {
  MCPServerConfig,
  AuthConfig,
  RateLimitConfig,
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPRequest,
  MCPContext,
} from './server/mcp-server';

export { Registry, defineTool, MCPServer };

export type {
  ToolContext,
  ToolContent,
  ToolResult,
  ToolDefinition,
  RegisteredTool,
  ResourceDefinition,
  MCPServerConfig,
  AuthConfig,
  RateLimitConfig,
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPRequest,
  MCPContext,
};

/** Minimal logger contract, matching what ToolContext expects. */
export type ToolLogger = ToolContext['logger'];

/**
 * Discards everything. Explicit no-op default so handlers can always call
 * ctx.logger without null checks, and so stdio transports do not corrupt the
 * protocol stream by writing logs to stdout.
 */
export const silentLogger: ToolLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Writes to stderr, never stdout.
 *
 * On the stdio transport, stdout carries JSON-RPC frames. A single stray
 * console.log corrupts the stream and the client drops the connection, which
 * presents as an unexplained disconnect rather than a logging bug.
 */
export function stderrLogger(prefix = 'mcp'): ToolLogger {
  const write = (level: string) => (msg: string, meta?: object) => {
    const line = { level, prefix, msg, ...(meta ?? {}) };
    process.stderr.write(`${JSON.stringify(line)}\n`);
  };

  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
  };
}

export interface ServeRegistryOptions {
  server: MCPServerConfig;
  logger?: ToolLogger;
  /** Abort a tool handler that exceeds this budget. Omit to disable. */
  toolTimeoutMs?: number;
}

/**
 * Mount every tool in a Registry onto an MCPServer.
 *
 * Handles three things the two layers do not agree on by themselves:
 *  - Schema source: the Registry's derived JSON Schema is authoritative
 *  - Context shape: ToolContext needs a logger and an AbortSignal, which
 *    MCPContext does not carry
 *  - Statistics: every call is timed and recorded so healthSnapshot() is real
 */
export function serveRegistry(
  registry: Registry,
  options: ServeRegistryOptions,
): MCPServer {
  const server = new MCPServer(options.server);
  const logger = options.logger ?? silentLogger;

  for (const listed of registry.listTools()) {
    const registered = registry.getTool(listed.name);
    if (!registered) continue;

    server.tool({
      name: registered.name,
      description: registered.description,
      inputSchema: registered.definition.input,
      handler: async (input: unknown, mcpContext: MCPContext) => {
        const controller = new AbortController();
        const timer =
          options.toolTimeoutMs !== undefined
            ? setTimeout(() => controller.abort(), options.toolTimeoutMs)
            : undefined;

        const context: ToolContext = {
          requestId: mcpContext.requestId,
          logger,
          user: mcpContext.clientId ? { id: mcpContext.clientId } : undefined,
          signal: controller.signal,
        };

        const startedAt = performance.now();

        try {
          const result = await registered.definition.handler(input, context);
          registry.recordCall(registered.name, performance.now() - startedAt);
          return result;
        } catch (error) {
          registry.recordCall(
            registered.name,
            performance.now() - startedAt,
            error as Error,
          );
          throw error;
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    });
  }

  for (const resource of registry.listResources()) {
    server.resource({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
      handler: async (uri: string) => {
        const resolved = registry.resolveResource(uri);
        if (!resolved) {
          throw new Error(`No registered resource matches "${uri}"`);
        }

        const payload = await resolved.definition.handler(resolved.params);
        const first = payload?.contents?.[0];

        return {
          content: first?.text ?? first?.blob ?? '',
          mimeType: first?.mimeType ?? resource.mimeType,
        };
      },
    });
  }

  return server;
}

/**
 * Convenience helper for the common shape: a text reply.
 * Saves repeating the content-array wrapper in every handler.
 */
export function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }] };
}

/**
 * Error reply. Sets isError so the client renders it as a failure instead of
 * handing the model an error string it may treat as data.
 */
export function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export { z };
