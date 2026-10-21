/**
 * An in-process MCP server over the repository (Node-only; BT68): requests in, parsed replies
 * out, and a `tool` shortcut that returns a tool's JSON result or its error text.
 */

import { REPO_ROOT } from '../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { nodeIo } from '../node-io.ts';
import { createMcpServer } from './command.ts';
import { DEFAULT_LIMITS, type McpLimits, type McpServer } from './server.ts';
import type { ExamplesContext } from './tools/examples.ts';

export function testServer(limits: Partial<McpLimits> = {}, root = REPO_ROOT): McpServer<ExamplesContext> {
  return createMcpServer({ root, limits: { ...DEFAULT_LIMITS, ...limits } }, nodeIo);
}

let nextId = 1;

/** One request; the parsed response object. */
export async function request(server: McpServer<ExamplesContext>, method: string, params?: object): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
  const line = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) }));
  if (line === undefined) throw new Error(`no reply to ${method}`);
  return JSON.parse(line) as { result?: Record<string, unknown>; error?: { code: number; message: string } };
}

export interface ToolReply {
  isError: boolean;
  text: string;
  /** The parsed JSON result (undefined for an error). */
  value: Record<string, unknown> | undefined;
}

/** Calls a tool; its JSON result or its error text. */
export async function tool(server: McpServer<ExamplesContext>, name: string, args: object = {}): Promise<ToolReply> {
  const reply = await request(server, 'tools/call', { name, arguments: args });
  if (reply.error !== undefined) throw new Error(`${name}: JSON-RPC error ${reply.error.code} ${reply.error.message}`);
  const result = reply.result as { content: { type: string; text: string }[]; isError?: boolean };
  const text = result.content[0].text;
  const isError = result.isError === true;
  return { isError, text, value: isError ? undefined : (JSON.parse(text) as Record<string, unknown>) };
}
