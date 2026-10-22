import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeIo } from '../node-io.ts';
import { TOOLS } from './command.ts';
import { handleLine, INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND, PARSE_ERROR, RpcError } from './jsonrpc.ts';
import { request, testServer } from './mcp.test-helper.ts';
import { Sandbox, SandboxError } from './sandbox.ts';
import { unknownKeywords, validate } from './schema.ts';
import { PROTOCOL_VERSIONS } from './server.ts';

// BT68: the MCP server's layers below the tools — JSON-RPC framing, the schema subset, the root
// sandbox, the lifecycle.

describe('JSON-RPC over lines', () => {
  const echo = (method: string, params: Record<string, unknown> | undefined): unknown => {
    if (method === 'boom') throw new RpcError(INVALID_PARAMS, 'bad', { why: 1 });
    if (method === 'crash') throw new Error('oops');
    return { method, params: params ?? null };
  };
  const reply = async (line: string): Promise<unknown> => {
    const out = await handleLine(line, echo);
    return out === undefined ? undefined : JSON.parse(out);
  };

  it('answers requests, not notifications, and ignores responses and blank lines', async () => {
    expect(await reply('{"jsonrpc":"2.0","id":7,"method":"a","params":{"x":1}}')).toEqual({ jsonrpc: '2.0', id: 7, result: { method: 'a', params: { x: 1 } } });
    expect(await reply('{"jsonrpc":"2.0","id":"s","method":"b"}')).toEqual({ jsonrpc: '2.0', id: 's', result: { method: 'b', params: null } });
    expect(await reply('{"jsonrpc":"2.0","method":"notify"}')).toBeUndefined();
    expect(await reply('{"jsonrpc":"2.0","method":"crash"}')).toBeUndefined();
    expect(await reply('{"jsonrpc":"2.0","id":3,"result":{}}')).toBeUndefined();
    expect(await reply('   ')).toBeUndefined();
  });

  it('reports parse errors, invalid requests and handler errors with their codes', async () => {
    expect(await reply('{nope')).toMatchObject({ id: null, error: { code: PARSE_ERROR } });
    expect(await reply('{"id":1,"method":"a"}')).toMatchObject({ error: { code: INVALID_REQUEST } });
    expect(await reply('{"jsonrpc":"2.0","id":{},"method":"a"}')).toMatchObject({ error: { code: INVALID_REQUEST } });
    expect(await reply('{"jsonrpc":"2.0","id":1,"method":"a","params":[1]}')).toMatchObject({ id: 1, error: { code: INVALID_PARAMS } });
    expect(await reply('{"jsonrpc":"2.0","id":1,"method":"boom"}')).toEqual({ jsonrpc: '2.0', id: 1, error: { code: INVALID_PARAMS, message: 'bad', data: { why: 1 } } });
    expect(await reply('{"jsonrpc":"2.0","id":2,"method":"crash"}')).toMatchObject({ id: 2, error: { code: -32603, message: 'oops' } });
    expect(await reply('[]')).toMatchObject({ error: { code: INVALID_REQUEST } });
  });

  it('answers a batch element by element, leaving out notifications', async () => {
    const out = (await reply('[{"jsonrpc":"2.0","id":1,"method":"a"},{"jsonrpc":"2.0","method":"n"},{"jsonrpc":"2.0","id":2,"method":"boom"}]')) as { id: number }[];
    expect(out.map((r) => r.id)).toEqual([1, 2]);
    expect(await reply('[{"jsonrpc":"2.0","method":"n"}]')).toBeUndefined();
  });
});

describe('the schema subset', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', maxLength: 3 },
      n: { type: 'integer', minimum: 1, maximum: 5 },
      kind: { type: 'string', enum: ['a', 'b'] },
      list: { type: 'array', maxItems: 2, items: { type: 'number' } },
      map: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['name'],
    additionalProperties: false,
  } as const;

  it('accepts conforming values and names every violation with its path', () => {
    expect(validate(schema, { name: 'abc', n: 3, kind: 'a', list: [1, 2.5], map: { x: 'y' } })).toEqual([]);
    expect(validate(schema, { name: 'abcd', n: 0, kind: 'c', list: [1, 'x', 3], map: { x: 1 }, extra: true })).toEqual([
      'name must be at most 3 characters',
      'n must be ≥ 1',
      'kind must be one of "a", "b"',
      'list must have at most 2 items',
      'list[1] must be a finite number, got a string',
      'map.x must be a string, got an integer',
      'extra is not an argument this tool takes',
    ]);
    expect(validate(schema, {})).toEqual(['name is required']);
    expect(validate(schema, [1])).toEqual(['arguments must be an object, got an array']);
    expect(validate({ type: 'integer' }, 1.5)).toEqual(['arguments must be an integer, got a number']);
  });

  it('every tool\'s input schema uses only the subset', () => {
    for (const tool of TOOLS) expect(unknownKeywords(tool.inputSchema), tool.name).toEqual([]);
    expect(unknownKeywords({ type: 'object', properties: { a: { type: 'string', format: 'uri' } as never } })).toEqual(['#/properties/a/format']);
  });
});

describe('the root sandbox', () => {
  it('keeps every path inside the root, symlinks followed', () => {
    const top = mkdtempSync(join(tmpdir(), 'benchtop-mcp-'));
    try {
      const root = join(top, 'root');
      mkdirSync(join(root, 'sub'), { recursive: true });
      writeFileSync(join(root, 'sub', 'a.json'), '{}');
      writeFileSync(join(top, 'secret.txt'), 'no');
      symlinkSync(join(top, 'secret.txt'), join(root, 'link.txt'));
      symlinkSync(join(root, 'sub'), join(root, 'inner'));
      const sandbox = new Sandbox(root);
      expect(sandbox.resolve('sub/a.json')).toBe(join(sandbox.root, 'sub', 'a.json'));
      expect(sandbox.resolve('inner/a.json')).toBe(join(sandbox.root, 'sub', 'a.json'));
      expect(sandbox.resolve(join(root, 'sub/a.json'))).toBe(join(sandbox.root, 'sub', 'a.json'));
      expect(sandbox.resolve('new/folder/out.txt')).toBe(join(sandbox.root, 'new', 'folder', 'out.txt'));
      for (const outside of ['../secret.txt', 'sub/../../secret.txt', join(top, 'secret.txt'), 'link.txt', '/etc/hosts', '']) {
        expect(() => sandbox.resolve(outside), outside).toThrow(SandboxError);
      }
      const io = sandbox.io(nodeIo);
      expect(new TextDecoder().decode(io.readFile('sub/a.json'))).toBe('{}');
      expect(() => io.readFile('link.txt')).toThrow(/outside the root/);
      expect(io.isDirectory('sub')).toBe(true);
      expect(io.isDirectory('missing')).toBe(false);
      expect(() => io.list('..')).toThrow(SandboxError);
      expect(io.list('sub')).toEqual([{ name: 'a.json', directory: false }]);
      expect(() => new Sandbox(join(top, 'nope'))).toThrow(/does not exist/);
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });
});

describe('MCP lifecycle', () => {
  it('negotiates the protocol version and says what it serves', async () => {
    const server = testServer();
    const init = await request(server, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'benchtop' } });
    expect(String(init.result?.instructions)).toMatch(/Paths are relative to the root folder/);
    expect(server.clientInfo).toEqual({ name: 'test', version: '1' });
    expect((await request(server, 'initialize', { protocolVersion: '2024-11-05' })).result?.protocolVersion).toBe('2024-11-05');
    expect((await request(server, 'initialize', { protocolVersion: '1999-01-01' })).result?.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
    expect((await request(server, 'ping')).result).toEqual({});
    expect((await request(server, 'prompts/list')).error?.code).toBe(METHOD_NOT_FOUND);
    expect(await server.handleLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toBeUndefined();
  });

  it('lists its tools with schemas and annotations; unknown tools are JSON-RPC errors, bad arguments tool errors', async () => {
    const server = testServer();
    const list = (await request(server, 'tools/list')).result as { tools: { name: string; inputSchema: { type: string }; annotations?: object }[] };
    expect(list.tools.map((t) => t.name)).toEqual(['list_parts', 'describe_part', 'validate_project', 'run_simulation', 'run_tests', 'sim_open', 'sim_run', 'sim_input', 'sim_serial', 'sim_state', 'sim_update', 'sim_reset', 'sim_close', 'sim_list', 'list_examples', 'open_example', 'debug_registers', 'debug_memory', 'debug_breakpoints', 'debug_step', 'compile_sketch', 'pcb_check', 'pcb_export']);
    for (const t of list.tools) expect(t.inputSchema.type).toBe('object');
    expect((await request(server, 'tools/call', { name: 'nope', arguments: {} })).error?.code).toBe(INVALID_PARAMS);
    const bad = (await request(server, 'tools/call', { name: 'describe_part', arguments: { type: 3, extra: 1 } })).result as { isError: boolean; content: { text: string }[] };
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toBe('invalid arguments for describe_part: type must be a string, got an integer; extra is not an argument this tool takes');
  });

  it('gives structuredContent from 2025-06-18 only', async () => {
    const server = testServer();
    await request(server, 'initialize', { protocolVersion: '2025-03-26' });
    expect((await request(server, 'tools/call', { name: 'list_parts', arguments: { query: 'uno' } })).result).not.toHaveProperty('structuredContent');
    await request(server, 'initialize', { protocolVersion: '2025-06-18' });
    const result = (await request(server, 'tools/call', { name: 'list_parts', arguments: { query: 'uno' } })).result as { structuredContent: { count: number }; content: { text: string }[] };
    expect(result.structuredContent.count).toBe(1);
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });
});
