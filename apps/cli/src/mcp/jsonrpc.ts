/**
 * JSON-RPC 2.0 as MCP's stdio transport carries it (BT68): one message per line, UTF-8, no
 * embedded newlines. `handleLine` parses a line, dispatches each request or notification to the
 * handler and returns the line to write back (undefined when nothing answers: notifications,
 * and responses a client sends — this server never sends requests). A batch (an array; older
 * protocol versions allow them) is answered element by element.
 */

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export type JsonRpcId = string | number;

/** An error the handler raises to answer with a JSON-RPC error object. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/** Handles one call: returns the result (requests) or nothing (notifications). Throws RpcError. */
export type RpcHandler = (method: string, params: Record<string, unknown> | undefined, notification: boolean) => unknown;

type Response = { jsonrpc: '2.0'; id: JsonRpcId | null; result: unknown } | { jsonrpc: '2.0'; id: JsonRpcId | null; error: { code: number; message: string; data?: unknown } };

function failure(id: JsonRpcId | null, code: number, message: string, data?: unknown): Response {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function handleMessage(message: unknown, handler: RpcHandler): Promise<Response | undefined> {
  if (!isRecord(message) || message.jsonrpc !== '2.0') return failure(null, INVALID_REQUEST, 'not a JSON-RPC 2.0 message');
  const hasId = 'id' in message;
  const id = message.id;
  if (hasId && typeof id !== 'string' && typeof id !== 'number') return failure(null, INVALID_REQUEST, 'id must be a string or a number');
  if (typeof message.method !== 'string') {
    // A response to a request (this server sends none) or garbage: nothing to answer.
    if (hasId && ('result' in message || 'error' in message)) return undefined;
    return failure(hasId ? (id as JsonRpcId) : null, INVALID_REQUEST, 'method must be a string');
  }
  const params = message.params;
  if (params !== undefined && !isRecord(params)) {
    return hasId ? failure(id as JsonRpcId, INVALID_PARAMS, 'params must be an object') : undefined;
  }
  try {
    const result = await handler(message.method, params, !hasId);
    return hasId ? { jsonrpc: '2.0', id: id as JsonRpcId, result: result ?? {} } : undefined;
  } catch (error) {
    if (!hasId) return undefined;
    if (error instanceof RpcError) return failure(id as JsonRpcId, error.code, error.message, error.data);
    return failure(id as JsonRpcId, INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
  }
}

/** One line in, the line to write back (or undefined). Never throws. */
export async function handleLine(line: string, handler: RpcHandler): Promise<string | undefined> {
  if (line.trim() === '') return undefined;
  let message: unknown;
  try {
    message = JSON.parse(line) as unknown;
  } catch {
    return JSON.stringify(failure(null, PARSE_ERROR, 'not JSON'));
  }
  if (Array.isArray(message)) {
    if (message.length === 0) return JSON.stringify(failure(null, INVALID_REQUEST, 'empty batch'));
    const responses: Response[] = [];
    for (const item of message) {
      const response = await handleMessage(item, handler);
      if (response !== undefined) responses.push(response);
    }
    return responses.length === 0 ? undefined : JSON.stringify(responses);
  }
  const response = await handleMessage(message, handler);
  return response === undefined ? undefined : JSON.stringify(response);
}
