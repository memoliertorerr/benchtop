/**
 * The Model Context Protocol server (BT68): lifecycle, tools and resources over the JSON-RPC
 * layer (jsonrpc.ts), for `bench mcp` (stdio) and in-process tests.
 *
 * - `initialize` answers with the client's protocol version when it is one this server speaks
 *   (`PROTOCOL_VERSIONS`), else the newest; capabilities `tools` and `resources` (no list
 *   changes, no subscriptions); `serverInfo`; `instructions` — how to start.
 * - `tools/list` gives every tool's name, title, description, input schema and annotations;
 *   `tools/call` checks the arguments against the schema, runs the tool and returns its result
 *   as one JSON text block (and as `structuredContent` from 2025-06-18). A tool that fails — bad
 *   arguments, a path outside the root, a project that doesn't parse, a missing ROM — returns
 *   `isError` with the message, so the assistant can correct itself; an unknown tool is a
 *   JSON-RPC error.
 * - `resources/list`, `resources/templates/list`, `resources/read` serve what the resource
 *   providers give (BT69 adds the gallery's examples).
 * - `ping` answers `{}`; notifications (`initialized`, `cancelled`, …) get no reply.
 */

import { ProjectError } from '@benchtop/core';
import { UsageError } from '../load.ts';
import { handleLine, INVALID_PARAMS, METHOD_NOT_FOUND, RpcError } from './jsonrpc.ts';
import { SandboxError } from './sandbox.ts';
import { type JsonSchema, validate } from './schema.ts';

/** Newest first. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
/** The first version with `structuredContent`. */
const STRUCTURED_SINCE = '2025-06-18';

export const SERVER_NAME = 'benchtop';
export const SERVER_VERSION = '0.20.0';

/** What a tool may spend per call (`bench mcp` flags). */
export interface McpLimits {
  /** Longest simulated time one call may run, ns. */
  maxSimNs: number;
  /** Wall-clock budget of one call, ms. */
  maxWallMs: number;
  /** Serial characters per board in one result. */
  serialChars: number;
  /** Live sessions open at once (BT69). */
  maxSessions: number;
}

export const DEFAULT_LIMITS: McpLimits = { maxSimNs: 60e9, maxWallMs: 30_000, serialChars: 64 * 1024, maxSessions: 8 };

/** A tool's own failure, reported to the client as an `isError` result. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface Tool<C = unknown> {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema & { type: 'object' };
  annotations?: ToolAnnotations;
  /** The result: a plain object (it becomes the JSON text and `structuredContent`). */
  run(args: Record<string, unknown>, context: C): object | Promise<object>;
}

export interface Resource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
}

export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
}

export interface ResourceProvider {
  list(): Resource[];
  templates(): ResourceTemplate[];
  /** The resource's text, or undefined when this provider doesn't have it. */
  read(uri: string): { mimeType: string; text: string } | undefined;
}

export interface McpServerOptions<C> {
  tools: readonly Tool<C>[];
  resources?: readonly ResourceProvider[];
  context: C;
  instructions?: string;
}

/** Errors a tool's own code throws for bad input, shown as tool errors (not internal errors). */
function isExpected(error: unknown): error is Error {
  return error instanceof ToolError || error instanceof UsageError || error instanceof SandboxError || error instanceof ProjectError;
}

export class McpServer<C> {
  private readonly tools = new Map<string, Tool<C>>();
  private readonly resources: readonly ResourceProvider[];
  private readonly context: C;
  private readonly instructions: string | undefined;
  /** The negotiated protocol version (the newest until `initialize`). */
  protocolVersion: string = PROTOCOL_VERSIONS[0];
  /** The client's name and version from `initialize`. */
  clientInfo: { name?: string; version?: string } = {};

  constructor(options: McpServerOptions<C>) {
    for (const tool of options.tools) {
      if (this.tools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
    this.resources = options.resources ?? [];
    this.context = options.context;
    this.instructions = options.instructions;
  }

  /** One line of the stdio transport in, the line to write back (or undefined). */
  handleLine(line: string): Promise<string | undefined> {
    return handleLine(line, (method, params, notification) => this.dispatch(method, params, notification));
  }

  private dispatch(method: string, params: Record<string, unknown> | undefined, notification: boolean): unknown {
    if (notification) return undefined; // initialized, cancelled, roots/list_changed: nothing to do
    switch (method) {
      case 'initialize':
        return this.initialize(params ?? {});
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: [...this.tools.values()].map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, ...(t.annotations === undefined ? {} : { annotations: t.annotations }) })) };
      case 'tools/call':
        return this.callTool(params ?? {});
      case 'resources/list':
        return { resources: this.resources.flatMap((r) => r.list()) };
      case 'resources/templates/list':
        return { resourceTemplates: this.resources.flatMap((r) => r.templates()) };
      case 'resources/read':
        return this.readResource(params ?? {});
      default:
        throw new RpcError(METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  private initialize(params: Record<string, unknown>): object {
    const asked = params.protocolVersion;
    this.protocolVersion = typeof asked === 'string' && (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
    const info = params.clientInfo;
    if (typeof info === 'object' && info !== null) {
      const { name, version } = info as Record<string, unknown>;
      this.clientInfo = { ...(typeof name === 'string' ? { name } : {}), ...(typeof version === 'string' ? { version } : {}) };
    }
    return {
      protocolVersion: this.protocolVersion,
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } },
      serverInfo: { name: SERVER_NAME, title: 'Benchtop', version: SERVER_VERSION },
      ...(this.instructions === undefined ? {} : { instructions: this.instructions }),
    };
  }

  private get structured(): boolean {
    return this.protocolVersion >= STRUCTURED_SINCE;
  }

  private async callTool(params: Record<string, unknown>): Promise<object> {
    const name = params.name;
    if (typeof name !== 'string') throw new RpcError(INVALID_PARAMS, 'tools/call needs a tool name');
    const tool = this.tools.get(name);
    if (tool === undefined) throw new RpcError(INVALID_PARAMS, `unknown tool: ${name}`);
    const args = params.arguments ?? {};
    const problems = validate(tool.inputSchema, args);
    if (problems.length > 0) return this.error(`invalid arguments for ${name}: ${problems.join('; ')}`);
    try {
      const value = await tool.run(args as Record<string, unknown>, this.context);
      return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(this.structured ? { structuredContent: value } : {}) };
    } catch (error) {
      if (isExpected(error)) return this.error(error.message);
      throw error;
    }
  }

  private error(message: string): object {
    return { content: [{ type: 'text', text: message }], isError: true };
  }

  private readResource(params: Record<string, unknown>): object {
    const uri = params.uri;
    if (typeof uri !== 'string') throw new RpcError(INVALID_PARAMS, 'resources/read needs a uri');
    for (const provider of this.resources) {
      const found = provider.read(uri);
      if (found !== undefined) return { contents: [{ uri, mimeType: found.mimeType, text: found.text }] };
    }
    throw new RpcError(-32002, `resource not found: ${uri}`);
  }
}

/**
 * Serves `server` over a line-based input and output (stdin/stdout for `bench mcp`), one message
 * at a time in arrival order; resolves when the input ends.
 */
export async function serveLines(server: McpServer<unknown>, lines: AsyncIterable<string>, write: (line: string) => void): Promise<void> {
  for await (const line of lines) {
    const reply = await server.handleLine(line);
    if (reply !== undefined) write(`${reply}\n`);
  }
}
