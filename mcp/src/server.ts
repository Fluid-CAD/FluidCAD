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
import {
  getApiSignature,
  listDocs,
  readDoc,
  searchDocs,
} from './tools/docs.ts';
import {
  getCompileError,
  getEdgeProperties,
  getFaceProperties,
  getSceneSummary,
  getShapeProperties,
  hitTest,
  listShapes,
} from './tools/inspection.ts';
import {
  getCameraState,
  screenshot,
  screenshotMulti,
  screenshotShape,
} from './tools/screenshot.ts';
import { loadDocsIndex, type DocsIndex } from './docs-index.ts';
import { registerDocResources } from './resources.ts';
import type { ToolResult } from './types.ts';

export const SERVER_NAME = 'fluidcad';
export const SERVER_VERSION = '0.0.33';

export type BuildServerOptions = {
  /** Pre-built docs index. Tests use this to inject a custom docs root. */
  docsIndex?: DocsIndex;
};

export function buildServer(options: BuildServerOptions = {}): McpServer {
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
        'Use list_docs/search_docs/read_doc/get_api_signature to learn the API.',
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

  const docsIndex = options.docsIndex ?? loadDocsIndex();

  server.registerTool(
    'list_docs',
    {
      title: 'List FluidCAD docs',
      description:
        'Returns every entry in the LLM doc set with id, title, summary, and tags. Optionally filter to a single tag (e.g. "solid", "concept").',
      inputSchema: {
        tag: z
          .string()
          .optional()
          .describe('Restrict the result to docs that carry this tag.'),
      },
    },
    async ({ tag }) => toMcp(listDocs(docsIndex, { tag })),
  );

  server.registerTool(
    'read_doc',
    {
      title: 'Read a FluidCAD doc by id',
      description:
        'Returns the full markdown body of a doc identified by id (e.g. "api/extrude", "concepts/scene-graph"). Use list_docs or search_docs to find ids.',
      inputSchema: {
        id: z.string().min(1).describe('Doc id from the manifest (e.g. "api/extrude").'),
      },
    },
    async ({ id }) => toMcp(readDoc(docsIndex, { id })),
  );

  server.registerTool(
    'search_docs',
    {
      title: 'Keyword search across FluidCAD docs',
      description:
        'Ranked keyword search over titles, summaries, tags, and bodies. Returns id/title/snippet/score for each hit.',
      inputSchema: {
        query: z.string().min(1).describe('Free-text query — keyword AND/OR is implicit.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum number of results to return (default 10).'),
      },
    },
    async ({ query, limit }) => toMcp(searchDocs(docsIndex, { query, limit })),
  );

  server.registerTool(
    'get_api_signature',
    {
      title: 'Get the signature block for an API symbol',
      description:
        'Looks up a single API symbol by name (e.g. "extrude") and returns its first code-block signature, the owning doc id, the doc title, and the one-line summary.',
      inputSchema: {
        name: z.string().min(1).describe('API symbol name, e.g. "extrude" or "fillet".'),
      },
    },
    async ({ name }) => toMcp(getApiSignature(docsIndex, { name })),
  );

  registerDocResources(server, docsIndex);

  const workspaceArg = {
    workspace: z
      .string()
      .optional()
      .describe(
        'Absolute workspace path of the target FluidCAD instance. Optional when only one workspace is running.',
      ),
  };

  const shapeIdArg = z.string().min(1).describe('Shape id from list_shapes or get_scene_summary.');
  const faceIndexArg = z
    .number()
    .int()
    .nonnegative()
    .describe('Zero-based face index inside the shape.');
  const edgeIndexArg = z
    .number()
    .int()
    .nonnegative()
    .describe('Zero-based edge index inside the shape.');
  const vec3 = z
    .tuple([z.number(), z.number(), z.number()])
    .describe('World-space [x, y, z] vector.');

  server.registerTool(
    'get_scene_summary',
    {
      title: 'Get the feature tree for a workspace',
      description:
        'Returns a JSON projection of the current scene: every scene object with its index, id, kind, parameters, source location, and the shape ids it produced. Use this before list_shapes when you need feature-tree context.',
      inputSchema: workspaceArg,
    },
    async ({ workspace }) => toMcp(await getSceneSummary({ workspace })),
  );

  server.registerTool(
    'list_shapes',
    {
      title: 'List all shapes in the current scene',
      description:
        'Returns a flat list of `{ shapeId, type, sceneObjectId }`. Cheaper than get_scene_summary when you only need ids — use this before calling shape/face/edge property tools.',
      inputSchema: workspaceArg,
    },
    async ({ workspace }) => toMcp(await listShapes({ workspace })),
  );

  server.registerTool(
    'get_compile_error',
    {
      title: 'Get the last cached compile error',
      description:
        'Returns `{ compileError: { message, filePath?, sourceLocation? } | null }`. Useful when the scene looks stale — a non-null value means the most recent render failed and the previous scene is still being served.',
      inputSchema: workspaceArg,
    },
    async ({ workspace }) => toMcp(await getCompileError({ workspace })),
  );

  server.registerTool(
    'get_shape_properties',
    {
      title: 'Get geometric properties of a shape',
      description:
        'Returns volume, surface area, bounding box, center of mass, and similar measurements for a single shape.',
      inputSchema: { ...workspaceArg, shapeId: shapeIdArg },
    },
    async ({ workspace, shapeId }) =>
      toMcp(await getShapeProperties({ workspace, shapeId })),
  );

  server.registerTool(
    'get_face_properties',
    {
      title: 'Get geometric properties of a face',
      description:
        'Returns area, normal, surface kind (plane/cylinder/...), and related measurements for a single face on a shape.',
      inputSchema: {
        ...workspaceArg,
        shapeId: shapeIdArg,
        faceIndex: faceIndexArg,
      },
    },
    async ({ workspace, shapeId, faceIndex }) =>
      toMcp(await getFaceProperties({ workspace, shapeId, faceIndex })),
  );

  server.registerTool(
    'get_edge_properties',
    {
      title: 'Get geometric properties of an edge',
      description:
        'Returns length, curve kind, endpoints, and related measurements for a single edge on a shape.',
      inputSchema: {
        ...workspaceArg,
        shapeId: shapeIdArg,
        edgeIndex: edgeIndexArg,
      },
    },
    async ({ workspace, shapeId, edgeIndex }) =>
      toMcp(await getEdgeProperties({ workspace, shapeId, edgeIndex })),
  );

  const namedViewArg = z.enum([
    'front', 'back', 'left', 'right', 'top', 'bottom',
    'iso-ftr', 'iso-fbr', 'iso-ftl', 'iso-fbl',
    'iso-btr', 'iso-bbr', 'iso-btl', 'iso-bbl',
  ]).describe('Named view direction. Cardinal axes (front, top, …) or one of 8 iso octants (iso-ftr = front-top-right, etc.).');

  const screenshotViewArg = z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('current') }),
      z.object({ kind: z.literal('named'), name: namedViewArg }),
      z.object({
        kind: z.literal('orbit-from-current'),
        azimuthDeg: z.number().describe('Spin around the up axis, in degrees.'),
        elevationDeg: z.number().describe('Tilt up/down relative to the current elevation, in degrees.'),
      }),
      z.object({
        kind: z.literal('look-from'),
        eye: vec3,
        target: vec3.optional(),
      }),
    ])
    .describe('Stateless camera view for this screenshot. Does not move the user\'s interactive camera.');

  const widthArg = z
    .number()
    .int()
    .min(1)
    .max(8192)
    .optional()
    .describe('Output width in pixels (default 800).');
  const heightArg = z
    .number()
    .int()
    .min(1)
    .max(8192)
    .optional()
    .describe('Output height in pixels (default 800).');
  const marginArg = z.number().nonnegative().optional();

  server.registerTool(
    'screenshot',
    {
      title: 'Capture a PNG of the current scene from a stateless view',
      description:
        'Renders the current FluidCAD scene to a PNG using a stateless camera view. The user\'s interactive camera is never moved. `view` defaults to the agent\'s last seen camera state — pass a `named` view (e.g. {kind:"named", name:"iso-ftr"}) for "show me from the front-top-right" or `look-from` for a precise vantage. Returns an MCP image content block.',
      inputSchema: {
        ...workspaceArg,
        view: screenshotViewArg.optional(),
        width: widthArg,
        height: heightArg,
        showGrid: z.boolean().optional(),
        showAxes: z.boolean().optional(),
        transparent: z.boolean().optional(),
        autoCrop: z.boolean().optional(),
        fitToModel: z.boolean().optional(),
        margin: marginArg,
      },
    },
    async (args) => toMcp(await screenshot(args as any)),
  );

  server.registerTool(
    'screenshot_multi',
    {
      title: 'Capture a 2×2 composite of front/top/right/iso views',
      description:
        'Renders a single PNG showing four canonical views (front, top, right, iso-ftr) as a 2×2 grid. Use this when the agent needs to "see all sides at once" without four separate tool calls. The user\'s interactive camera is never moved.',
      inputSchema: {
        ...workspaceArg,
        width: widthArg,
        height: heightArg,
        showGrid: z.boolean().optional(),
        showAxes: z.boolean().optional(),
        transparent: z.boolean().optional(),
        margin: marginArg,
      },
    },
    async (args) => toMcp(await screenshotMulti(args as any)),
  );

  server.registerTool(
    'screenshot_shape',
    {
      title: 'Capture a framed iso view of a single shape',
      description:
        'Fetches the shape\'s bounding box and renders a PNG from an iso vantage point that frames it with a small margin. Useful for "show me this specific feature" requests.',
      inputSchema: {
        ...workspaceArg,
        shapeId: shapeIdArg,
        margin: z
          .number()
          .positive()
          .optional()
          .describe('Distance multiplier on the bounding sphere (default 1.2). Larger values pull the camera farther back.'),
        width: widthArg,
        height: heightArg,
        showGrid: z.boolean().optional(),
        showAxes: z.boolean().optional(),
        transparent: z.boolean().optional(),
      },
    },
    async (args) => toMcp(await screenshotShape(args as any)),
  );

  server.registerTool(
    'get_camera_state',
    {
      title: 'Get the user\'s current camera position and target',
      description:
        'Returns `{ position, target, up, projection }` for the user\'s interactive camera, as last broadcast by the UI. Useful before computing an orbit-from-current view.',
      inputSchema: workspaceArg,
    },
    async ({ workspace }) => toMcp(await getCameraState({ workspace })),
  );

  server.registerTool(
    'hit_test',
    {
      title: 'Ray-test a shape',
      description:
        'Cast a ray against a shape and return the face/edge it hits (if any). `rayOrigin` and `rayDir` are world-space [x, y, z]. `edgeThreshold` is a screen-space tolerance for edge hits.',
      inputSchema: {
        ...workspaceArg,
        shapeId: shapeIdArg,
        rayOrigin: vec3,
        rayDir: vec3,
        edgeThreshold: z
          .number()
          .nonnegative()
          .optional()
          .describe('Optional edge-hit tolerance (default 0 — face-only hit test).'),
      },
    },
    async ({ workspace, shapeId, rayOrigin, rayDir, edgeThreshold }) =>
      toMcp(
        await hitTest({
          workspace,
          shapeId,
          rayOrigin: rayOrigin as [number, number, number],
          rayDir: rayDir as [number, number, number],
          edgeThreshold,
        }),
      ),
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
    const data = result.data as any;
    // Image results are rendered as MCP `image` blocks so multimodal clients
    // can display the PNG inline without burning the agent's text budget.
    if (data && typeof data === 'object' && data.image && typeof data.image.base64 === 'string') {
      return {
        content: [
          {
            type: 'image' as const,
            data: data.image.base64,
            mimeType: data.image.mimeType ?? 'image/png',
          },
        ],
      };
    }
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

export { z };
