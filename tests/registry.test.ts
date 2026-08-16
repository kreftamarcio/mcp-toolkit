import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Registry, defineTool } from '../src/core/registry';
import type { ToolContext, ToolResult } from '../src/core/registry';

function context(): ToolContext {
  return {
    requestId: 'req-1',
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    signal: new AbortController().signal,
  };
}

const echo = defineTool({
  name: 'echo',
  description: 'Returns the message it was given',
  input: z.object({ message: z.string() }),
  handler: async (args): Promise<ToolResult> => ({
    content: [{ type: 'text', text: args.message }],
  }),
});

describe('registerTool validation', () => {
  it('registers a valid tool', () => {
    const registry = new Registry();
    expect(() => registry.registerTool(echo)).not.toThrow();
    expect(registry.getTool('echo')).toBeDefined();
  });

  it('rejects a duplicate name, since clients address tools by name', () => {
    const registry = new Registry();
    registry.registerTool(echo);

    expect(() => registry.registerTool(echo)).toThrow(/already registered/);
  });

  it('rejects an empty description, which makes a tool unusable to a model', () => {
    const registry = new Registry();

    expect(() =>
      registry.registerTool({ ...echo, name: 'blank', description: '   ' }),
    ).toThrow(/empty description/);
  });

  it('rejects names containing characters that break addressing', () => {
    const registry = new Registry();

    expect(() => registry.registerTool({ ...echo, name: 'bad name' })).toThrow(
      /Invalid tool name/,
    );
    expect(() => registry.registerTool({ ...echo, name: '' })).toThrow(
      /Invalid tool name/,
    );
  });

  it('accepts underscores and hyphens', () => {
    const registry = new Registry();

    expect(() =>
      registry.registerTool({ ...echo, name: 'get_user-profile' }),
    ).not.toThrow();
  });
});

describe('listTools', () => {
  it('derives an inline JSON Schema from the Zod schema', () => {
    const registry = new Registry();
    registry.registerTool(echo);

    const [listed] = registry.listTools();

    expect(listed.name).toBe('echo');
    expect(listed.inputSchema).toMatchObject({ type: 'object' });
    expect(JSON.stringify(listed.inputSchema)).not.toContain('$ref');
  });

  it('annotates destructive tools so clients can warn before calling', () => {
    const registry = new Registry();
    registry.registerTool({ ...echo, name: 'delete_all', destructive: true });

    const [listed] = registry.listTools();
    expect(listed.annotations?.destructiveHint).toBe(true);
  });

  it('omits the annotation for non-destructive tools', () => {
    const registry = new Registry();
    registry.registerTool(echo);

    expect(registry.listTools()[0].annotations).toBeUndefined();
  });
});

describe('handler wiring', () => {
  it('passes validated arguments through to the handler', async () => {
    const registry = new Registry();
    registry.registerTool(echo);

    const tool = registry.getTool('echo')!;
    const result = await tool.definition.handler({ message: 'ola' }, context());

    expect(result.content[0].text).toBe('ola');
  });
});

describe('resources and URI templates', () => {
  const contact = {
    uri: 'crm://contacts/{id}',
    name: 'Contact',
    handler: async (params: Record<string, string>) => ({
      contents: [{ uri: `crm://contacts/${params.id}`, text: `contact ${params.id}` }],
    }),
  };

  it('resolves a concrete URI against a template', () => {
    const registry = new Registry();
    registry.registerResource(contact);

    const resolved = registry.resolveResource('crm://contacts/42');

    expect(resolved).not.toBeNull();
    expect(resolved!.params).toEqual({ id: '42' });
  });

  it('decodes percent-encoded segments', () => {
    const registry = new Registry();
    registry.registerResource(contact);

    const resolved = registry.resolveResource('crm://contacts/a%40b.com');
    expect(resolved!.params.id).toBe('a@b.com');
  });

  it('does not match across a path separator', () => {
    const registry = new Registry();
    registry.registerResource(contact);

    expect(registry.resolveResource('crm://contacts/42/notes')).toBeNull();
  });

  it('returns null when nothing matches', () => {
    const registry = new Registry();
    registry.registerResource(contact);

    expect(registry.resolveResource('other://thing/1')).toBeNull();
  });

  it('rejects a duplicate resource URI', () => {
    const registry = new Registry();
    registry.registerResource(contact);

    expect(() => registry.registerResource(contact)).toThrow(/already registered/);
  });
});

describe('healthSnapshot', () => {
  it('starts every counter at zero', () => {
    const registry = new Registry();
    registry.registerTool(echo);

    const snapshot = registry.healthSnapshot();

    expect(snapshot.toolCount).toBe(1);
    expect(snapshot.tools[0]).toMatchObject({
      name: 'echo',
      calls: 0,
      errorRate: 0,
      avgLatencyMs: 0,
    });
  });

  it('computes an error rate per tool rather than in aggregate', () => {
    const registry = new Registry();
    registry.registerTool(echo);

    registry.recordCall('echo', 100);
    registry.recordCall('echo', 200, new Error('upstream 503'));

    const [stats] = registry.healthSnapshot().tools;

    expect(stats.calls).toBe(2);
    expect(stats.errorRate).toBe(0.5);
    expect(stats.avgLatencyMs).toBe(150);
    expect(stats.lastErrorMessage).toBe('upstream 503');
  });

  it('ignores calls recorded for an unknown tool', () => {
    const registry = new Registry();
    registry.registerTool(echo);

    expect(() => registry.recordCall('ghost', 10)).not.toThrow();
    expect(registry.healthSnapshot().tools[0].calls).toBe(0);
  });
});

describe('clear', () => {
  it('drops all registrations for hot reload', () => {
    const registry = new Registry();
    registry.registerTool(echo);
    registry.clear();

    expect(registry.listTools()).toHaveLength(0);
    expect(registry.getTool('echo')).toBeUndefined();

    // Re-registering the same name must succeed after a clear
    expect(() => registry.registerTool(echo)).not.toThrow();
  });
});
