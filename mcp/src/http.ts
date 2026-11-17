// Serves MCP over the SDK's streamable HTTP transport, mounted by a host on a
// route of its own (the engine mounts one per agent chat session).
//
// The transport is stateful: `initialize` opens a session keyed by the
// `mcp-session-id` header, with a server of its own from `buildServer`. Only
// a stateful session delivers a client's `notifications/cancelled` to the
// running handler (`extra.signal`), which a tool gate needs to stop waiting
// on an approval. Clients do not always DELETE their session on exit (Claude
// Code does not), so the host calls `close()` when it knows the client is
// gone.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export type McpHttpHandlerOptions = {
  /** Builds the server for one new MCP session; called on every `initialize`. */
  buildServer: () => McpServer;
};

/** A request as Express hands it over: `body` is set when a JSON body parser ran. */
export type McpHttpRequest = IncomingMessage & { body?: unknown };

export type McpHttpHandler = {
  /**
   * Serves one HTTP request of the MCP endpoint (POST, GET or DELETE). A
   * body the host already parsed (`express.json()`) is used as is;
   * otherwise it is read from the request.
   */
  handle(req: McpHttpRequest, res: ServerResponse): Promise<void>;
  /**
   * Closes every open session and its server. Calls still running are
   * aborted (their `extra.signal` fires). The handler stays usable: a new
   * `initialize` opens a new session.
   */
  close(): Promise<void>;
  /** Open sessions. */
  readonly sessionCount: number;
};

type Session = { transport: StreamableHTTPServerTransport; server: McpServer };

const SESSION_HEADER = 'mcp-session-id';

export function createMcpHttpHandler(options: McpHttpHandlerOptions): McpHttpHandler {
  const sessions = new Map<string, Session>();

  async function openSession(req: McpHttpRequest, res: ServerResponse, body: unknown): Promise<void> {
    const server = options.buildServer();
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, server });
      },
    });
    // Set before connect(): the server chains its own close handling after it.
    transport.onclose = () => {
      if (transport.sessionId !== undefined) {
        sessions.delete(transport.sessionId);
      }
    };
    await server.connect(transport);
    try {
      await transport.handleRequest(req, res, body);
    } finally {
      // An initialize the transport refused leaves no session behind.
      if (transport.sessionId === undefined || !sessions.has(transport.sessionId)) {
        await server.close().catch(() => {});
      }
    }
  }

  async function handle(req: McpHttpRequest, res: ServerResponse): Promise<void> {
    try {
      const sessionId = headerValue(req.headers[SESSION_HEADER]);
      if (sessionId !== undefined) {
        const session = sessions.get(sessionId);
        if (!session) {
          // The spec's answer to an unknown or closed session: the client
          // starts a new one with initialize.
          sendJsonRpcError(res, 404, -32001, 'Session not found');
          return;
        }
        const body = req.method === 'POST' ? await requestBody(req) : undefined;
        await session.transport.handleRequest(req, res, body);
        return;
      }

      if (req.method !== 'POST') {
        sendJsonRpcError(res, 400, -32000, 'Bad Request: no MCP session; send initialize first.');
        return;
      }
      const body = await requestBody(req);
      if (!isInitializeRequest(body)) {
        sendJsonRpcError(res, 400, -32000, 'Bad Request: no MCP session; send initialize first.');
        return;
      }
      await openSession(req, res, body);
    } catch (e) {
      if (e instanceof BodyParseError) {
        sendJsonRpcError(res, 400, -32700, `Parse error: ${e.message}`);
        return;
      }
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
      } else {
        res.end();
      }
    }
  }

  async function close(): Promise<void> {
    const open = [...sessions.values()];
    sessions.clear();
    await Promise.all(
      open.map(async ({ transport, server }) => {
        await transport.close().catch(() => {});
        await server.close().catch(() => {});
      }),
    );
  }

  return {
    handle,
    close,
    get sessionCount() {
      return sessions.size;
    },
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value === '' ? undefined : value;
}

class BodyParseError extends Error {}

async function requestBody(req: McpHttpRequest): Promise<unknown> {
  if (req.body !== undefined) {
    return req.body;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new BodyParseError(e instanceof Error ? e.message : String(e));
  }
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}
