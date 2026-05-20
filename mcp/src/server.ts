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
import { waitForIdle, waitForRender } from './tools/coordination.ts';
import {
  editRange,
  listFluidFiles,
  readFile,
  writeFile,
} from './tools/source.ts';
import {
  addBreakpoint,
  clearBreakpoints,
  exportShapes,
  importStep,
  recompute,
  rollbackTo,
} from './tools/engine.ts';
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
        '',
        '`.fluid.js` files MUST import every FluidCAD symbol they use:',
        '  import { sketch, rect, extrude } from "fluidcad/core";',
        '  import { face, edge } from "fluidcad/filters";',
        '  import { outside, enclosed } from "fluidcad/constraints";',
        'write_file and edit_range refuse `.fluid.js` writes that use a known',
        'FluidCAD symbol without an import (code: "missing-imports"). The error',
        '`details.suggestion` is a copy-pasteable block of the imports to add.',
        '',
        'write_file and edit_range are synchronous: the response carries the',
        'render outcome under `render`. Check `render.state === "rendered"`',
        'before calling screenshot or inspection. On `compile-error`, the',
        'previous scene is still being served — fix the source and retry.',
        'wait_for_render only matters for renders you did NOT trigger (e.g.',
        'observing a user-driven live edit).',
        'write_file and edit_range refuse to clobber a buffer the editor has',
        'unsaved changes for (code: "dirty-buffer"). Surface the conflicting',
        'paths to the user before retrying with `force: true`.',
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

  const timeoutMsArg = z
    .number()
    .positive()
    .optional()
    .describe('Hard upper bound in milliseconds (default 10000).');

  server.registerTool(
    'wait_for_render',
    {
      title: 'Wait for the next render to complete',
      description:
        'Blocks until the next `render-version: end` (or `error`) WS message arrives, or `timeoutMs` elapses. Pair with edits that trigger a render (e.g. write_file) so subsequent screenshot/inspection calls see the latest scene. Returns `{ state: "rendered", version, absPath, durationMs }`. Errors with code `compile-error` if the render failed, or `timeout` if no completion was observed.',
      inputSchema: { ...workspaceArg, timeoutMs: timeoutMsArg },
    },
    async ({ workspace, timeoutMs }) => toMcp(await waitForRender({ workspace, timeoutMs })),
  );

  server.registerTool(
    'wait_for_idle',
    {
      title: 'Wait until renders have settled',
      description:
        'Blocks until no `render-version: start` has been observed for `stableMs` (default 200ms), or `timeoutMs` elapses (default 10000ms). Useful when the user might be live-editing in the editor and the agent wants to capture a stable scene. Returns `{ idleMs, lastVersion }`.',
      inputSchema: {
        ...workspaceArg,
        timeoutMs: timeoutMsArg,
        stableMs: z
          .number()
          .nonnegative()
          .optional()
          .describe('Quiet window in milliseconds (default 200). Must be strictly less than `timeoutMs`.'),
      },
    },
    async ({ workspace, timeoutMs, stableMs }) =>
      toMcp(await waitForIdle({ workspace, timeoutMs, stableMs })),
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

  // -------------------------------------------------------------------------
  // Source editing — read/write `.fluid.js` files inside the workspace.
  // -------------------------------------------------------------------------

  const pathArg = z
    .string()
    .min(1)
    .describe('Path relative to the workspace root (or absolute, as long as it resolves inside the workspace).');

  const forceArg = z
    .boolean()
    .optional()
    .describe(
      'Destructive override — write even if the editor has unsaved changes for this file. Surface the dirty-files list to the user before passing true.',
    );

  const positionArg = z
    .object({
      line: z.number().int().nonnegative().describe('Zero-based line number.'),
      column: z.number().int().nonnegative().describe('Zero-based UTF-16 column.'),
    })
    .describe('Source position (LSP-style, 0-based line and 0-based UTF-16 column).');

  server.registerTool(
    'list_fluid_files',
    {
      title: 'List every .fluid.js file in the workspace',
      description:
        'Walks the workspace recursively and returns workspace-relative paths for every `.fluid.js` file. Skips `node_modules`, `.git`, `.fluidcad`, `dist`, `build`.',
      inputSchema: workspaceArg,
    },
    async ({ workspace }) => toMcp(await listFluidFiles({ workspace })),
  );

  server.registerTool(
    'read_file',
    {
      title: 'Read a UTF-8 file from the workspace',
      description:
        'Returns the full contents of a file under the workspace root. Paths that escape the workspace (via `..` or symlinks) are rejected.',
      inputSchema: { ...workspaceArg, path: pathArg },
    },
    async ({ workspace, path }) => toMcp(await readFile({ workspace, path })),
  );

  server.registerTool(
    'write_file',
    {
      title: 'Replace a file inside the workspace (atomic)',
      description:
        'Writes `content` to `path` (UTF-8, tmp+rename atomic), then synchronously triggers a render and returns the outcome under `render` (`state`: rendered | compile-error | superseded | no-scene-manager | render-failed, plus `version`, `durationMs`, optional `compileError`). For `.fluid.js` files, refuses writes that use a known FluidCAD symbol without an `import { … } from "fluidcad/…"` line — fails with code `missing-imports` and `details.suggestion` shows the imports to add. Also refuses to clobber a file the editor extension reports as dirty — fails with code `dirty-buffer` whose `details.dirtyFiles` lists every dirty path. Pass `force: true` to override either guard. No need to call `wait_for_render` afterwards.',
      inputSchema: {
        ...workspaceArg,
        path: pathArg,
        content: z.string().describe('Full UTF-8 file contents to write.'),
        force: forceArg,
      },
    },
    async ({ workspace, path, content, force }) =>
      toMcp(await writeFile({ workspace, path, content, force })),
  );

  server.registerTool(
    'edit_range',
    {
      title: 'Replace a [start, end) range inside a workspace file (atomic)',
      description:
        'Replaces the half-open range `[start, end)` in `path` with `newText`. Positions are 0-based `{ line, column }` (UTF-16 columns). End-of-line and end-of-file overrun clamp gracefully. Same dirty-buffer guard, missing-imports guard (for `.fluid.js` files), `force` semantics, and synchronous `render` outcome as `write_file`. No need to call `wait_for_render` afterwards.',
      inputSchema: {
        ...workspaceArg,
        path: pathArg,
        start: positionArg,
        end: positionArg,
        newText: z.string().describe('Replacement text (may be empty to delete the range).'),
        force: forceArg,
      },
    },
    async ({ workspace, path, start, end, newText, force }) =>
      toMcp(await editRange({ workspace, path, start, end, newText, force })),
  );

  // -------------------------------------------------------------------------
  // Engine control — recompute, rollback, breakpoints, import/export.
  // -------------------------------------------------------------------------

  server.registerTool(
    'recompute',
    {
      title: 'Force a full recompute of the current file',
      description:
        'Discards the cached scene and re-runs the current `.fluid.js` file. Pair with `wait_for_render` before screenshot or inspection.',
      inputSchema: workspaceArg,
    },
    async ({ workspace }) => toMcp(await recompute({ workspace })),
  );

  server.registerTool(
    'rollback_to',
    {
      title: 'Temporarily roll back the rendered scene to a feature index',
      description:
        'Stops rendering at scene-object `index` so the UI shows the model up to that step. Mutates only UI/render state — the source file is unchanged, and the next `recompute` or live-update resets to the full scene. Pair with `wait_for_render` before screenshotting.',
      inputSchema: {
        ...workspaceArg,
        index: z
          .number()
          .int()
          .nonnegative()
          .describe('Zero-based scene-object index to stop rendering at. Use 0 to show only the first feature.'),
      },
    },
    async ({ workspace, index }) => toMcp(await rollbackTo({ workspace, index })),
  );

  server.registerTool(
    'add_breakpoint',
    {
      title: 'Set a breakpoint on a source line',
      description:
        'Halts rendering at the given line on the next recompute. Subsequent `recompute` produces a partial scene up to (but not including) the line. Use `clear_breakpoints` to remove all breakpoints.',
      inputSchema: {
        ...workspaceArg,
        file: z
          .string()
          .min(1)
          .describe('Absolute path to the .fluid.js file to break in (e.g. from `get_scene_summary().file`).'),
        line: z.number().int().nonnegative().describe('Zero-based line number to break on.'),
      },
    },
    async ({ workspace, file, line }) => toMcp(await addBreakpoint({ workspace, file, line })),
  );

  server.registerTool(
    'clear_breakpoints',
    {
      title: 'Remove every breakpoint in the workspace',
      description: 'Clears all source-line breakpoints; subsequent renders run end-to-end.',
      inputSchema: workspaceArg,
    },
    async ({ workspace }) => toMcp(await clearBreakpoints({ workspace })),
  );

  server.registerTool(
    'import_step',
    {
      title: 'Import a STEP file into the workspace',
      description:
        'Reads `path` from disk, base64-encodes the bytes, and posts to the server\'s import pipeline. The imported geometry shows up as a new shape in the current scene.',
      inputSchema: {
        ...workspaceArg,
        path: z
          .string()
          .min(1)
          .describe('Absolute path to a STEP file (.step or .stp) on the local filesystem.'),
      },
    },
    async ({ workspace, path }) => toMcp(await importStep({ workspace, path })),
  );

  server.registerTool(
    'export',
    {
      title: 'Export shapes to STEP or STL',
      description:
        'Exports the listed shapes to a STEP or STL file. Prefer `saveAsPath` (must resolve inside the workspace root) — the encoded bytes can be multi-MB and shouldn\'t round-trip through the agent\'s context. Returns `{ savedTo, bytesWritten }` when saved, or `{ format, mimeType, base64, bytes }` otherwise. For STL, `resolution: "fine"` produces the cleanest mesh but is slow; default to `"medium"` unless the user asks for higher fidelity.',
      inputSchema: {
        ...workspaceArg,
        format: z.enum(['step', 'stl']).describe('Output format.'),
        shapeIds: z
          .array(z.string().min(1))
          .min(1)
          .describe('Shape ids to export (from `list_shapes` or `get_scene_summary`).'),
        saveAsPath: z
          .string()
          .optional()
          .describe('Workspace-relative or absolute path to write the export to. Must resolve inside the workspace root.'),
        resolution: z
          .enum(['coarse', 'medium', 'fine'])
          .optional()
          .describe('STL mesh resolution. Ignored for STEP. Defaults to "medium".'),
        includeColors: z
          .boolean()
          .optional()
          .describe('Include per-face color metadata (STEP/STL with color extension).'),
      },
    },
    async ({ workspace, format, shapeIds, saveAsPath, resolution, includeColors }) =>
      toMcp(
        await exportShapes({
          workspace,
          format,
          shapeIds,
          saveAsPath,
          resolution,
          includeColors,
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
