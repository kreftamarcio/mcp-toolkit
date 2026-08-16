import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export interface ToolContext {
  requestId: string;
  logger: {
    debug: (msg: string, meta?: object) => void;
    info: (msg: string, meta?: object) => void;
    warn: (msg: string, meta?: object) => void;
    error: (msg: string, meta?: object) => void;
  };
  user?: { id: string; [key: string]: unknown };
  signal: AbortSignal;
}

export interface ToolContent {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

/**
 * A tool definition. The generic parameter is inferred from the Zod schema,
 * so the handler receives fully typed arguments with no manual annotation.
 */
export interface ToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  input: TSchema;
  handler: (args: z.infer<TSchema>, ctx: ToolContext) => Promise<ToolResult>;
  /** Optional per-tool rate limit override. */
  rateLimit?: { requestsPerMinute: number };
  /** Marks the tool as having side effects, surfaced in introspection. */
  destructive?: boolean;
}

/**
 * Identity helper that preserves the schema's inferred type through to the
 * handler signature. Without this, callers would have to annotate `args`
 * manually and could annotate it wrongly.
 */
export function defineTool<TSchema extends z.ZodTypeAny>(
  definition: ToolDefinition<TSchema>,
): ToolDefinition<TSchema> {
  return definition;
}

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  destructive: boolean;
  definition: ToolDefinition;
  stats: ToolStats;
}

interface ToolStats {
  calls: number;
  errors: number;
  totalLatencyMs: number;
  lastCalledAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
}

export interface ResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  handler: (params: Record<string, string>) => Promise<{
    contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }>;
  } | null>;
}

/**
 * Central registry for tools, resources, and prompts.
 *
 * Responsibilities:
 * - Validate registrations at registration time, not at first call
 * - Derive the JSON Schema advertised to clients from the Zod schema
 * - Track per-tool call statistics for health reporting
 * - Resolve URI templates for resources
 */
export class Registry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly resources = new Map<string, ResourceDefinition>();

  registerTool<TSchema extends z.ZodTypeAny>(definition: ToolDefinition<TSchema>): void {
    this.assertValidToolName(definition.name);

    if (this.tools.has(definition.name)) {
      throw new Error(
        `Tool "${definition.name}" is already registered. ` +
        `Tool names must be unique because clients address tools by name.`,
      );
    }

    if (!definition.description.trim()) {
      throw new Error(
        `Tool "${definition.name}" has an empty description. ` +
        `The description is how a model decides whether to call this tool, ` +
        `so an empty one makes the tool effectively unusable.`,
      );
    }

    // Derive JSON Schema once at registration. Doing it per-request would
    // repeat identical work on every tools/list call.
    let inputSchema: Record<string, unknown>;
    try {
      inputSchema = zodToJsonSchema(definition.input, {
        target: 'jsonSchema7',
        $refStrategy: 'none', // MCP clients expect inline schemas
      }) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Failed to derive JSON Schema for tool "${definition.name}": ` +
        `${(error as Error).message}. ` +
        `Some Zod constructs (transforms, refinements on the root object) ` +
        `cannot be represented in JSON Schema.`,
      );
    }

    this.tools.set(definition.name, {
      name: definition.name,
      description: definition.description,
      inputSchema,
      destructive: definition.destructive ?? false,
      definition: definition as ToolDefinition,
      stats: {
        calls: 0,
        errors: 0,
        totalLatencyMs: 0,
        lastCalledAt: null,
        lastErrorAt: null,
        lastErrorMessage: null,
      },
    });
  }

  registerResource(definition: ResourceDefinition): void {
    if (this.resources.has(definition.uri)) {
      throw new Error(`Resource "${definition.uri}" is already registered`);
    }
    this.resources.set(definition.uri, definition);
  }

  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Response payload for the MCP `tools/list` method.
   */
  listTools(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: { destructiveHint: boolean };
  }> {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.destructive ? { annotations: { destructiveHint: true } } : {}),
    }));
  }

  listResources(): Array<{ uri: string; name: string; description?: string; mimeType?: string }> {
    return Array.from(this.resources.values()).map(r => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  }

  /**
   * Match a concrete URI against registered URI templates.
   *
   * Template `crm://contacts/{id}` matches `crm://contacts/42`
   * and yields `{ id: '42' }`.
   */
  resolveResource(uri: string): { definition: ResourceDefinition; params: Record<string, string> } | null {
    for (const definition of this.resources.values()) {
      const params = this.matchUriTemplate(definition.uri, uri);
      if (params) {
        return { definition, params };
      }
    }
    return null;
  }

  recordCall(name: string, latencyMs: number, error?: Error): void {
    const tool = this.tools.get(name);
    if (!tool) return;

    tool.stats.calls++;
    tool.stats.totalLatencyMs += latencyMs;
    tool.stats.lastCalledAt = new Date().toISOString();

    if (error) {
      tool.stats.errors++;
      tool.stats.lastErrorAt = tool.stats.lastCalledAt;
      tool.stats.lastErrorMessage = error.message;
    }
  }

  /**
   * Health snapshot. Error rate per tool is the signal that matters here:
   * a tool failing every call is invisible in aggregate request counts.
   */
  healthSnapshot(): {
    toolCount: number;
    resourceCount: number;
    tools: Array<{
      name: string;
      calls: number;
      errorRate: number;
      avgLatencyMs: number;
      lastErrorMessage: string | null;
    }>;
  } {
    return {
      toolCount: this.tools.size,
      resourceCount: this.resources.size,
      tools: Array.from(this.tools.values()).map(t => ({
        name: t.name,
        calls: t.stats.calls,
        errorRate: t.stats.calls > 0 ? t.stats.errors / t.stats.calls : 0,
        avgLatencyMs: t.stats.calls > 0
          ? Math.round(t.stats.totalLatencyMs / t.stats.calls)
          : 0,
        lastErrorMessage: t.stats.lastErrorMessage,
      })),
    };
  }

  /**
   * Replace all registrations. Used by hot-reload in development.
   */
  clear(): void {
    this.tools.clear();
    this.resources.clear();
  }

  private matchUriTemplate(template: string, uri: string): Record<string, string> | null {
    const paramNames: string[] = [];

    // Escape regex metacharacters, then turn {param} into a capture group.
    const pattern = template
      .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
      .replace(/\{(\w+)\}/g, (_match, name: string) => {
        paramNames.push(name);
        return '([^/]+)';
      });

    const match = new RegExp(`^${pattern}$`).exec(uri);
    if (!match) return null;

    const params: Record<string, string> = {};
    for (let i = 0; i < paramNames.length; i++) {
      params[paramNames[i]!] = decodeURIComponent(match[i + 1]!);
    }
    return params;
  }

  private assertValidToolName(name: string): void {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
      throw new Error(
        `Invalid tool name "${name}". ` +
        `Tool names must be 1-64 characters of letters, digits, underscore, or hyphen. ` +
        `Clients use these as identifiers, so spaces and punctuation break addressing.`,
      );
    }
  }
}
