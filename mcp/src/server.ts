// Builds the MCP server and exposes transport-agnostic entry points.
//
// The server itself is transport-agnostic: `buildServer()` constructs an
// `McpServer` with every tool registered, and `runStdio()` is the only piece
// that knows about stdio. Phase 12 will add a parallel `runHttp(app)` that
// binds the same `McpServer` to a streamable HTTP transport.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { listWorkspaces } from './tools/workspaces.ts';
import type { ToolResult } from './types.ts';

export const SERVER_NAME = 'fluidcad';
export const SERVER_VERSION = '0.0.33';

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions: [
        'Drives a running FluidCAD workspace.',
        'Call list_workspaces first to find available workspaces.',
        'All paths are workspace-absolute.',
      ].join('\n'),
    },
  );

  server.registerTool(
    'list_workspaces',
    {
      title: 'List running FluidCAD workspaces',
      description:
        'Returns every running FluidCAD workspace on this machine (from ~/.fluidcad/instances.json), with a quick liveness probe per entry.',
      inputSchema: {},
    },
    async () => {
      const result = await listWorkspaces();
      return toMcp(result);
    },
  );

  return server;
}

export async function runStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Render a tool result into the MCP `CallToolResult` shape. Success: a JSON
 * text block. Failure: also a text block, but with `isError: true` so MCP
 * clients render it as a tool-error rather than a normal response.
 */
function toMcp<T>(result: ToolResult<T>) {
  if (result.ok === true) {
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(result.data, null, 2) },
      ],
    };
  }
  const failure = result as Extract<ToolResult<T>, { ok: false }>;
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          { code: failure.code, message: failure.message, details: failure.details },
          null,
          2,
        ),
      },
    ],
  };
}

// Silence "unused import" — z is re-exported for tool modules that will
// import it from here once they have schemas to declare. (Phase 4+.)
export { z };
