// Builds the MCP server and exposes transport-agnostic entry points.
//
// The server itself is transport-agnostic: `buildServer()` constructs an
// `McpServer` with every tool registered, and `runStdio()` is the only piece
// that knows about stdio. Phase 12 will add a parallel `runHttp(app)` that
// binds the same `McpServer` to a streamable HTTP transport.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { listWorkspaces } from './tools/workspaces.ts';
import {
  getApiSignature,
  getTypeDefinition,
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
  measure,
  resolveSelection,
  validate,
  interfere,
} from './tools/inspection.ts';
import {
  getCameraState,
  screenshot,
  screenshotMulti,
  screenshotShape,
} from './tools/screenshot.ts';
import { waitForIdle } from './tools/coordination.ts';
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
  packModel,
  recompute,
  rollbackTo,
} from './tools/engine.ts';
import { loadDocsIndex, type DocsIndex } from './docs-index.ts';
import { registerDocResources } from './resources.ts';
import type { ToolResult } from './types.ts';

export const SERVER_NAME = 'FluidCAD';
export const SERVER_VERSION = readPackageVersion();

function readPackageVersion(): string {
  // Read the root `fluidcad` package.json — npm always ships it with the
  // published package, and it's the version bumped by `npm run release`.
  // From `mcp/dist/server.js`, this resolves to `<pkg-root>/package.json`
  // both in the source tree and when installed under `node_modules/fluidcad/`.
  try {
    const pkgPath = path.resolve(import.meta.dirname, '../../package.json');
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (typeof parsed.version === 'string') {
      return parsed.version;
    }
  } catch {
    // Fall through to unknown.
  }
  return '0.0.0';
}

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
        'When a signature mentions an unfamiliar type (e.g. PlaneLike, AxisLike,',
        'SceneObject, LinearRepeatOptions), call get_type_definition with the',
        'type name to resolve its accepted forms / methods / properties.',
        'All paths are workspace-absolute.',
        '',
        '`.fluid.js` files MUST import every FluidCAD symbol they use:',
        '  import { sketch, line, extrude } from "fluidcad/core";',
        '  import { face, edge } from "fluidcad/filters";',
        '  import { coincident, distance } from "fluidcad/constraints";',
        'write_file and edit_range refuse `.fluid.js` writes that use a known',
        'FluidCAD symbol without an import (code: "missing-imports"). The error',
        '`details.suggestion` is a copy-pasteable block of the imports to add.',
        '',
        'write_file, edit_range, recompute, rollback_to, and import_step are',
        'synchronous: they return once the render settles. write_file and',
        'edit_range additionally carry the outcome under `render` — check',
        '`render.state === "rendered"` before calling screenshot or',
        'inspection. On `compile-error`, the previous scene is still being',
        'served; fix the source and retry.',
        '',
        'A render can finish and still be wrong: a feature whose build fails is',
        'skipped, not fatal. That is `state: "build-error"`, with every failed',
        'feature listed under `objectErrors` (name, message, 1-based',
        'sourceLocation). recompute and rollback_to report the same two fields.',
        'Never report a model as done on a build-error — fix the listed',
        'features or tell the user what failed.',
        '',
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

  server.registerTool(
    'get_type_definition',
    {
      title: 'Get the definition of a documented type',
      description:
        'Resolves a type name (e.g. "PlaneLike", "SceneObject", "LinearRepeatOptions") to its TypeScript definition, accepted forms / methods / properties, and the owning doc id. Accepts both display names and internal aliases (e.g. "ISceneObject" → "SceneObject").',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe('Type name, e.g. "PlaneLike", "AxisLike", "SceneObject", "LinearRepeatOptions".'),
      },
    },
    async ({ name }) => toMcp(getTypeDefinition(docsIndex, { name })),
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
  // A fixed-length array rather than z.tuple(): the MCP SDK converts Zod v4
  // schemas with a draft-07 target, and draft-07 encodes tuples as
  // `items: [...]`. JSON Schema 2020-12 — the dialect LLM providers validate
  // tool schemas against — requires `items` to be a single schema, so the
  // tuple form makes the whole tool unusable for those clients.
  const vec3 = z
    .array(z.number())
    .length(3)
    .describe('World-space [x, y, z] vector.');

  server.registerTool(
    'get_scene_summary',
    {
      title: 'Get the feature tree for a workspace',
      description:
        'Returns a JSON projection of the current scene: every scene object with its index, id, kind, parameters, source location, and the shape ids it produced, plus `unit` — the document unit (mm/cm/m/in/ft) every length in the parameters is in. Use this before list_shapes when you need feature-tree context.',
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
        'Returns volume, surface area, bounding box, center of mass, and similar measurements for a single shape. Values are in the document unit, returned as `unit` (the `volumeMm3`/`surfaceAreaMm2` field names are historical — an inch document reports in³/in² under them).',
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
        'Returns area, normal, surface kind (plane/cylinder/...), and related measurements for a single face on a shape. Lengths and areas are in the document unit, returned as `unit` (`areaMm2` is a historical field name).',
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
        'Returns length, curve kind, endpoints, and related measurements for a single edge on a shape. Lengths are in the document unit, returned as `unit`.',
      inputSchema: {
        ...workspaceArg,
        shapeId: shapeIdArg,
        edgeIndex: edgeIndexArg,
      },
    },
    async ({ workspace, shapeId, edgeIndex }) =>
      toMcp(await getEdgeProperties({ workspace, shapeId, edgeIndex })),
  );

  const selectionScopeArg = z
    .union([
      z.object({ sceneObjectId: z.string().min(1).describe('A scene object id from get_scene_summary; the scope is that object\'s enclosing part.') }),
      z.object({ part: z.string().min(1).describe('A part name (or a part\'s scene object id).') }),
      z.object({ instanceId: z.string().min(1).describe('Assembly files: an inserted instance id from get_scene_summary.') }),
    ])
    .optional()
    .describe(
      'Where the expression is evaluated. Omitted: root scope — the whole scene, as a root-level select() sees it. ' +
      '{ sceneObjectId } or { part }: only that part\'s own geometry, exactly what a select() inside part("name", ...) sees ' +
      '(a filter scoped to part "base" never matches faces of part "pillar"). { instanceId }: that instance\'s part build, ' +
      'matches carrying instanceId and the statement pose so they feed measure unchanged.',
    );

  const expressionArg = z
    .string()
    .min(1)
    .describe(
      'FluidCAD filter syntax, the same text you would write inside select(...): face().onPlane("xy", 10), ' +
      'edge().circle(5), face().cylinder().withTangents(). Only face, edge and $obj are in scope. $obj maps scene object ids ' +
      '(from get_scene_summary) to the objects, so face().from($obj["<id>"]) selects one feature\'s faces across part scopes ' +
      'and $obj["<id>"].endFaces() / .startEdges() accessors work; when you write the expression into the file, swap $obj["<id>"] ' +
      'for the variable that holds that feature. Plain JavaScript otherwise: no module, host or scene-manager access.',
    );

  const pickArg = z.object({
    shapeId: z.string().min(1).describe('Solid id from list_shapes / get_scene_summary / hit_test.'),
    kind: z.enum(['face', 'edge']),
    index: z.number().int().nonnegative().describe('The face/edge index in that solid — the index hit_test, measure and resolve_selection matches report.'),
  });

  server.registerTool(
    'resolve_selection',
    {
      title: 'Resolve a selection and synthesize the selector to write for it',
      description:
        'Two inputs, one of them: `expression` — a filter expression evaluated with exactly the candidate set a select() statement ' +
        'would see at the given scope; or `picks` — explicit face/edge refs (from hit_test, a screenshot highlight, or an earlier ' +
        'match). Returns every matched face/edge with its shapeId/kind/index (usable in measure and hit_test), owning ' +
        'sceneObjectId and part, and a compact summary: form (plane/cylinder/cone/sphere/torus/surface or line/circle/arc/ellipse/curve), ' +
        'center [x,y,z], normal or axis, area or length, diameter for cylinders/spheres/circles. Lengths are in the document unit ' +
        '(returned as `unit`), rounded to its meaningful precision. Zero matches is a normal result with count 0 — check it before ' +
        'writing a fillet/chamfer/color on that filter, which would silently do nothing.\n\n' +
        '`synthesized` is the selector the language itself would write for exactly those matches — the same ranked, verified ' +
        'synthesis the UI runs on a pick: a feature accessor on a bound variable (`e.endEdges()`, `c.sideFaces(2)`) beats a filter ' +
        'that bakes geometry constants (`edge().circle(5)`), and every candidate is verified to resolve to exactly the matches. ' +
        'Read `synthesized.source` and write THAT into the file — it uses the file\'s real variable names; each entry in ' +
        '`synthesized.producers` says which statement a name refers to and whether it is already `bound` (bound: false means ' +
        'add `const <variable> = ` in front of that statement first). `synthesized.expression` is the same selector in this ' +
        'tool\'s `$obj["<id>"]` form, so you can resolve it again to double-check; `sameAsInput` tells you whether synthesis kept ' +
        'your expression or found a better form; `alternatives` are verified runner-ups (source + expression) if the winner ' +
        'reads badly in context; `imports` lists symbols the source form needs (select, edge, face, plane). A `synthesized.ok: false` ' +
        'names why no selector could be verified (geometry from a loop or helper call site, picks across part scopes) — the matches ' +
        'are still valid, use a filter you verify by count.\n\n' +
        '`before` is the statement boundary: the scene-object `index` (get_scene_summary) of the statement the selection is written ' +
        'before — the statement you are editing, or the one a new statement is inserted in front of. Only objects strictly before it ' +
        'exist then (the world rollback_to(before - 1) renders), so the selector resolves and synthesizes against the geometry that ' +
        'statement actually sees, with picks addressed on that world\'s solids. Omit it for a statement appended at the end. ' +
        'A `warning` names selected shapes no solid in the visible world carries (a later feature consumed them): re-select on the ' +
        'visible geometry. An expression that fails to evaluate, an unknown scope, a part name shared by several variants, an ' +
        'out-of-range boundary or a pick that does not exist in that world is an error naming the problem.',
      inputSchema: {
        ...workspaceArg,
        expression: expressionArg.optional(),
        picks: z
          .array(pickArg)
          .min(1)
          .max(500)
          .optional()
          .describe('Explicit face/edge refs to synthesize a selector for, instead of an expression. Exactly one of expression / picks.'),
        scope: selectionScopeArg,
        before: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Statement boundary: the scene-object index of the statement the selection is written before (an edited statement, or the ' +
            'insertion point of a new one). Objects strictly before it are visible — the same world as rollback_to(before - 1). ' +
            'Omit when the statement goes at the end of the file.',
          ),
      },
    },
    async ({ workspace, expression, picks, scope, before }) =>
      toMcp(await resolveSelection({ workspace, expression, picks, scope: scope as any, before })),
  );

  server.registerTool(
    'validate',
    {
      title: 'Check the rendered geometry is sound (closed, oriented, valid topology)',
      description:
        'Kernel soundness checks on the solids the scene renders. `render.state === "rendered"` is not a geometry claim: an open ' +
        'five-face box and an inside-out solid both render and screenshot fine. Run this on every new solid before measuring or ' +
        'screenshotting it. Each finding names the shapeId, the owning sceneObjectId and part, the instance ids it applies to in an ' +
        'assembly, a `kind` and a short message. Kinds: `invalidTopology` (BRepCheck_Analyzer found a defect: a wire that does not ' +
        'close, pcurves off their surface, an edge without faces); `openShell` (a shell with a free edge, so no enclosed volume); ' +
        '`nonPositiveVolume` (signed volume <= 0 — inversion is caught by the volume sign ONLY, because the analyzer accepts a ' +
        'reversed solid as valid; measured per solid, never summed, so +1000 and -1000 cannot cancel); `noSolid` (the shape holds ' +
        'no solid at all). Self-intersection is NOT checked: this kernel build exposes neither BRepAlgoAPI_Check nor ' +
        'BOPAlgo_ArgumentAnalyzer, and the result says so under `notChecked`; do not claim it. Result: `ok` (true only with zero ' +
        'findings), `checked` (shapes examined), `findings`, `shapes` (per shape: faces, edges, solids, signed `volume` in the ' +
        'document unit cubed, finding kinds), `skipped` (shapes that could not be examined, with why), `checks` (what ran), `unit`. ' +
        'Default is every solid the scene renders (a solid a later cut consumed is not rendered, so not checked). `shapeIds` ' +
        'narrows to those shapes — and lets you name a non-solid shape, which reports `noSolid`. In an assembly, instances of one ' +
        'part share its prototype: each shape is checked once and `instanceIds` lists every instance showing it; `instanceId` ' +
        'narrows to that instance\'s part. An unknown shape or instance, or no rendered scene, is an error naming the problem.',
      inputSchema: {
        ...workspaceArg,
        shapeIds: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe('Only these shape ids (from list_shapes or get_scene_summary). Omit to check every solid the scene renders.'),
        instanceId: z
          .string()
          .min(1)
          .optional()
          .describe('Assembly files: only the shapes of this instance\'s part prototype (instance ids from get_scene_summary).'),
      },
    },
    async ({ workspace, shapeIds, instanceId }) =>
      toMcp(await validate({ workspace, shapeIds, instanceId })),
  );

  const instancePoseArg = z.object({
    instanceId: z.string().min(1).describe('The instance this pose is for (ids from get_scene_summary).'),
    position: z.object({ x: z.number(), y: z.number(), z: z.number() }),
    quaternion: z.object({ x: z.number(), y: z.number(), z: z.number(), w: z.number() }),
  });

  server.registerTool(
    'interfere',
    {
      title: 'Check whether any two bodies occupy the same space',
      description:
        'Interference check over the solids the scene renders: every candidate pair is bounds-rejected, then the surviving pairs run ' +
        'a boolean common and report the volume they share. The unit of the verdict is the PART: in an assembly, a pair of bodies from ' +
        'two different instances that share more than `tolerance` is a `clash`; two bodies inside one instance (a multi-solid part) ' +
        'are listed under `intraPart` and never fail. In a part file with several part() blocks the same rule applies per part; with no ' +
        'parts, every solid is its own unit. `tolerance` is the smallest shared volume, in the document unit cubed, that counts ' +
        '(default: the equivalent of 1 mm³, because touching faces yield slivers). Fewer than two bodies, or all bodies in one ' +
        'part/instance, is `inconclusive` with `ok: false` — it is NOT a pass; say so rather than claiming clearance. `ok` is true ' +
        'only when at least two parts were compared, no pair clashed and no pair failed. Result: `ok`, `inconclusive` (reason, when ' +
        'set), `bodies`, `units` (parts or instances compared), `checked` (pairs whose boolean ran — the cost), `rejectedByBounds`, ' +
        '`clashes` and `intraPart` (each pair: two bodies with shapeId, sceneObjectId, part, instanceId in an assembly, and the shared ' +
        '`volume`), `failed` (pairs whose boolean threw, with the message; not cleared), `tolerance`, `unit`. Assembly instances sit ' +
        'at their STATEMENT poses (insert().translate()/.rotate()); mate-solved or dragged poses seen in the viewport are not applied ' +
        'unless you pass `poses` (a world pose per instance, from get_scene_summary after a viewport drag writes it back). `instanceIds` ' +
        'with one id tests that instance against every other body; with two or more, only the named instances among themselves. ' +
        '`shapeIds` narrows to those shapes (every instance showing them). An unknown shape or instance, or no rendered scene, is an ' +
        'error naming the problem.',
      inputSchema: {
        ...workspaceArg,
        instanceIds: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe('Assembly files: one id tests that instance against everything; two or more test only the named instances among themselves (ids from get_scene_summary).'),
        shapeIds: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe('Only these shape ids (from list_shapes or get_scene_summary). Omit to check every solid the scene renders.'),
        tolerance: z
          .number()
          .min(0)
          .optional()
          .describe('Smallest shared volume that counts, in the document unit cubed. Default: the equivalent of 1 mm³.'),
        poses: z
          .array(instancePoseArg)
          .min(1)
          .optional()
          .describe('Assembly files: world poses to use instead of the statement poses, per instance.'),
      },
    },
    async ({ workspace, instanceIds, shapeIds, tolerance, poses }) =>
      toMcp(await interfere({ workspace, instanceIds, shapeIds, tolerance, poses })),
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

  const measureIndexEntityArg = z.object({
    shapeId: shapeIdArg,
    kind: z.enum(['face', 'edge']).describe('Whether the index refers to a face or an edge of the shape.'),
    index: z.number().int().nonnegative().describe('Zero-based face/edge index inside the shape.'),
    instanceId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Assembly files only: the inserted instance the entity belongs to (instance ids come from get_scene_summary). ' +
        'Instances of one part share a shapeId, and the entity is measured where the instance sits per its insert() ' +
        'statement (translate/rotate) — mate-solved or dragged poses seen in the viewport are not applied.',
      ),
  });

  const measureFilterEntityArg = z.object({
    expression: expressionArg,
    scope: selectionScopeArg,
  });

  const measureEntityArg = z.union([measureIndexEntityArg, measureFilterEntityArg]);

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

  const idListArg = z.array(z.string().min(1)).min(1).max(64);
  const sectionArg = z
    .object({
      plane: z
        .union([
          z.enum(['xy', 'yz', 'xz']).describe('A world datum plane through the origin: xy (normal +Z), yz (normal +X) or xz (normal +Y).'),
          z.object({
            origin: vec3.describe('A point on the cut plane, document units.'),
            normal: vec3.describe('The plane normal; it points at the half that is removed.'),
          }),
        ])
        .describe('The cut plane: a named datum plane or an explicit { origin, normal }, document units.'),
      offset: z.number().optional().describe('Moves the cut plane along its normal, document units (default 0). { plane: "xy", offset: 10 } cuts at z = 10.'),
      flip: z.boolean().optional().describe('Keep the other half: the side the normal points at stays and the far side is removed.'),
    })
    .optional()
    .describe(
      'Section (cut-away) view, document units. The model is cut on the plane and the half the normal points at is removed, so the ' +
      'picture shows the cut from the normal\'s side; by default the far half (the side the normal points away from) is kept. Cut ' +
      'faces are capped in the body\'s colour so solids read solid and holes read hollow; highlights are clipped with the model. ' +
      'Use it when a bore, blind hole, counterbore or wall cannot be seen from outside; grid and axes are not cut.',
    );
  const screenshotOverlayArgs = {
    highlight: z
      .array(measureEntityArg)
      .min(1)
      .max(64)
      .optional()
      .describe(
        'Faces/edges to draw highlighted — translucent fill on faces, thick line on edges — visible through whatever occludes them, ' +
        'so a bore or a far-side face shows. Each entry is an index ref { shapeId, kind, index, instanceId? } or a filter { expression, scope? } ' +
        'as in measure; a filter highlights every entity it matches (ambiguity is fine here), one matching nothing is an error.',
      ),
    hide: idListArg.optional().describe('Shape ids (from get_scene_summary) or assembly instance ids left out of the render. Exclusive with focus.'),
    focus: idListArg.optional().describe('Shape ids or instance ids kept as they are while everything else is ghosted in place (faint, silhouettes kept) so the context stays. Exclusive with hide.'),
    annotations: z
      .array(z.object({
        from: vec3.describe('Line start, document units.'),
        to: vec3.describe('Line end, document units.'),
        label: z.string().max(200).optional().describe('Text drawn beside the line\'s midpoint.'),
      }))
      .min(1)
      .max(32)
      .optional()
      .describe('Point-to-point lines with end markers and a text label, painted in screen space over the capture.'),
    fitTo: z
      .literal('highlight')
      .optional()
      .describe('Frame the highlighted entities\' combined bounding box (plus annotation points) instead of the whole model, the way screenshot_shape frames one shape. Needs highlight.'),
    section: sectionArg,
  };

  const measureImageArg = z
    .object({
      view: screenshotViewArg.optional().describe('Defaults to the iso-ftr named view.'),
      width: widthArg,
      height: heightArg,
      pixelRatio: z.number().min(1).max(4).optional(),
      section: sectionArg,
    })
    .optional()
    .describe(
      'When given, the result also carries a PNG (returned as an image block after the JSON) showing the measured entities highlighted, ' +
      'the two realizing points of the primary value joined by a line labelled with that value and the unit, framed to the entities. ' +
      'Ask for it when the numbers alone leave doubt about which geometry was measured; add `section` when the measured geometry is internal.',
    );

  server.registerTool(
    'measure',
    {
      title: 'Measure distances and angles between faces/edges',
      description:
        'Measures the selected faces/edges like a CAD measure tool. One entity returns its area/length; two entities ' +
        'return min/max distance with their realizing points, plus parallel/center/axis distance and angle when the ' +
        'geometry relation supports them. `primary` names the headline value. Lengths are in the document unit (returned as `unit`), angles in degrees. ' +
        'Each entity is either an index reference { shapeId, kind, index, instanceId? } or a filter { expression, scope? } as in ' +
        'resolve_selection; a filter must resolve to exactly one face/edge — several matches are refused with the candidates listed, ' +
        'none is an error — and the measured entity reports the expression, sceneObjectId and part it resolved to. Every measured entity ' +
        'carries the same compact `summary` (form, center, normal/axis, area/length, diameter) resolve_selection returns. ' +
        'Pass `image` to get a picture of the measurement as well.',
      inputSchema: {
        ...workspaceArg,
        entities: z
          .array(measureEntityArg)
          .min(1)
          .max(8)
          .describe('Faces/edges to measure (1-8), by index or by filter expression. Pairwise measurements are computed when exactly 2 are given.'),
        image: measureImageArg,
      },
    },
    async ({ workspace, entities, image }) => toMcp(await measure({ workspace, entities: entities as any, image: image as any })),
  );

  server.registerTool(
    'screenshot',
    {
      title: 'Capture a PNG of the current scene from a stateless view',
      description:
        'Renders the current FluidCAD scene to a PNG using a stateless camera view. The user\'s interactive camera is never moved. `view` defaults to the agent\'s last seen camera state — pass a `named` view (e.g. {kind:"named", name:"iso-ftr"}) for "show me from the front-top-right" or `look-from` for a precise vantage. ' +
        '`highlight` draws faces/edges (by index or filter expression) through occluders, `hide`/`focus` drop or ghost other shapes, `annotations` add labelled lines, `fitTo: "highlight"` frames the highlighted geometry, and `section` cuts the model away on one side of a plane (cut faces capped) to show bores, blind holes and walls. Returns an MCP image content block.',
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
        solidsOnly: z.boolean().optional().describe('Render only the model\'s solids: hides sketches, construction planes/axes, connectors and overlays, and lifts sketch-mode ghosting. Fitting frames the solids alone.'),
        showDimensions: z.boolean().optional().describe('Show sketch dimensional-constraint annotations (distance, angle, radius, diameter). Default true; pass false to declutter a sketch capture.'),
        showPositional: z.boolean().optional().describe('Show sketch positional-constraint badges and coincidence dots. Default true.'),
        framePlanes: z.boolean().optional().describe('Include construction-plane quads (plane(…) features) in the bounds that fitting and auto-crop frame. Default false: a plane quad is 200 mm square whatever the model, so it is left out unless the picture is about the planes.'),
        pixelRatio: z.number().min(1).max(4).optional().describe('Device-pixel ratio of the export (default 1). Overlays such as constraint badges and dimension readouts are sized for a width/pixelRatio CSS-pixel canvas, so a 2× export viewed at half size shows them at on-screen size.'),
        ...screenshotOverlayArgs,
      },
    },
    async (args) => toMcp(await screenshot(args as any)),
  );

  server.registerTool(
    'screenshot_multi',
    {
      title: 'Capture a labelled grid of several views in one PNG',
      description:
        'Renders one PNG with 2-6 views laid out two per row, each cell labelled with its view in the corner. Default views: iso-ftr, its opposite iso-bbl ' +
        '(two opposed isometrics show every face in at least one cell), top and front. Pass `views` for other vantages (named, look-from, orbit-from-current). ' +
        'Use this to "see all sides at once" without several tool calls; the overlay options (highlight, hide, focus, annotations, fitTo, section) apply to every cell. The user\'s interactive camera is never moved.',
      inputSchema: {
        ...workspaceArg,
        views: z
          .array(screenshotViewArg)
          .min(2)
          .max(6)
          .optional()
          .describe('The cells\' views, 2-6, row-major two per row. Default: iso-ftr, iso-bbl, top, front.'),
        width: widthArg,
        height: heightArg,
        showGrid: z.boolean().optional(),
        showAxes: z.boolean().optional(),
        transparent: z.boolean().optional(),
        margin: marginArg,
        pixelRatio: z.number().min(1).max(4).optional().describe('Device-pixel ratio of the export (default 1); cell labels and annotations scale with it.'),
        ...screenshotOverlayArgs,
      },
    },
    async (args) => toMcp(await screenshotMulti(args as any)),
  );

  server.registerTool(
    'screenshot_shape',
    {
      title: 'Capture a framed iso view of a single shape',
      description:
        'Fetches the shape\'s bounding box and renders a PNG from an iso vantage point that frames it with a small margin. Useful for "show me this specific feature" requests. Takes the same highlight/hide/focus/annotations/fitTo/section overlays as screenshot.',
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
        ...screenshotOverlayArgs,
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

  const includeChangesArg = z
    .boolean()
    .optional()
    .describe(
      'Default true: the render outcome carries `changes` — which scene objects the render rebuilt, added, removed and how many it reused, each with exact bounds before and after (no volumes; call get_shape_properties on the named objects for those). Pass false on a very large model to skip the summary.',
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
        'Writes `content` to `path` (UTF-8, tmp+rename atomic), then synchronously triggers a render and returns the outcome under `render` (`state`: rendered | build-error | compile-error | superseded | no-scene-manager | render-failed, plus `version`, `durationMs`, optional `compileError`). `build-error` means the file ran but one or more features failed to build — `render.objectErrors` lists each one (`name`, `uniqueKind`, `message`, 1-based `sourceLocation`) and the scene is missing their geometry; only `rendered` means the model matches the source. `render.changes` (unless `includeChanges: false`) says what the render actually rebuilt: `rebuilt` (objects built again, each with `sceneObjectId`, `name`, `kind`, `sourceLocation`, `shapes` and exact `bounds.before` / `bounds.after` of its solids — volumes are not included), `added`, `removed`, `reused` (count served from cache, geometry untouched) and `truncated` when a list hit its 50-entry cap. Re-verify the rebuilt objects; an object you did not mean to touch appearing under `rebuilt` with different bounds is an unintended downstream change. For FluidCAD script files (`.fluid.js`, `.part.js`, `.assembly.js`), refuses writes that use a known FluidCAD symbol without an `import { … } from "fluidcad/…"` line — fails with code `missing-imports` and `details.suggestion` shows the imports to add — and writes whose `unit()` statement breaks a placement rule (must be top-level, before any geometry, once per file, a string literal, never in a `*.assembly.js` file) — fails with code `unit-statement` and `details.diagnostics` lists each violation with its 0-based line. Also refuses to clobber a file the editor extension reports as dirty — fails with code `dirty-buffer` whose `details.dirtyFiles` lists every dirty path. Pass `force: true` to override either guard.',
      inputSchema: {
        ...workspaceArg,
        path: pathArg,
        content: z.string().describe('Full UTF-8 file contents to write.'),
        force: forceArg,
        includeChanges: includeChangesArg,
      },
    },
    async ({ workspace, path, content, force, includeChanges }) =>
      toMcp(await writeFile({ workspace, path, content, force, includeChanges })),
  );

  server.registerTool(
    'edit_range',
    {
      title: 'Replace a [start, end) range inside a workspace file (atomic)',
      description:
        'Replaces the half-open range `[start, end)` in `path` with `newText`. Positions are 0-based `{ line, column }` (UTF-16 columns). End-of-line and end-of-file overrun clamp gracefully. Same dirty-buffer guard, missing-imports and unit-statement guards (for FluidCAD script files), `force` semantics, and synchronous `render` outcome (including `render.changes`: rebuilt / added / removed objects with exact before and after bounds, plus the reused count) as `write_file`.',
      inputSchema: {
        ...workspaceArg,
        path: pathArg,
        start: positionArg,
        end: positionArg,
        newText: z.string().describe('Replacement text (may be empty to delete the range).'),
        force: forceArg,
        includeChanges: includeChangesArg,
      },
    },
    async ({ workspace, path, start, end, newText, force, includeChanges }) =>
      toMcp(await editRange({ workspace, path, start, end, newText, force, includeChanges })),
  );

  // -------------------------------------------------------------------------
  // Engine control — recompute, rollback, breakpoints, import/export.
  // -------------------------------------------------------------------------

  server.registerTool(
    'recompute',
    {
      title: 'Force a full recompute of the current file',
      description:
        'Discards the cached scene and re-runs the current `.fluid.js` file. Synchronous — returns once the render settles. Reports `state` (rendered | build-error) and `objectErrors` for any feature that failed to build, plus `changes` (unless `includeChanges: false`): every object is `rebuilt` since nothing is cached, each with exact `bounds.before` / `bounds.after` of its solids (no volumes), so a differing pair is geometry that changed since the last render.',
      inputSchema: { ...workspaceArg, includeChanges: includeChangesArg },
    },
    async ({ workspace, includeChanges }) => toMcp(await recompute({ workspace, includeChanges })),
  );

  server.registerTool(
    'rollback_to',
    {
      title: 'Temporarily roll back the rendered scene to a feature index',
      description:
        'Stops rendering at scene-object `index` so the UI shows the model up to that step. Mutates only UI/render state — the source file is unchanged, and the next `recompute` or live-update resets to the full scene. Synchronous — returns once the rollback render settles, reporting `state` (rendered | build-error) and `objectErrors` for failed features still inside the rollback scope.',
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
        'Reads `path` from disk, base64-encodes the bytes, and posts to the server\'s import pipeline. The imported geometry shows up as a new shape in the current scene. The reply reports `solidCount` and `sourceUnits` (the unit names the STEP file declared, e.g. `INCH`); the cached geometry is always mm and `load()` scales it into the loading document\'s unit, so no unit argument is needed.',
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
      title: 'Export shapes or the whole assembly to STEP or STL',
      description:
        'Exports the listed shapes — or, with `assembly: true`, the whole current assembly (every inserted part where it sits: one STEP assembly with shared part prototypes, or one STL mesh) — to a STEP or STL file. Pass exactly one of `shapeIds` / `assembly`. Prefer `saveAsPath` (must resolve inside the workspace root) — the encoded bytes can be multi-MB and shouldn\'t round-trip through the agent\'s context. Returns `{ savedTo, bytesWritten }` when saved, or `{ format, mimeType, base64, bytes }` otherwise; assembly exports add `posesSource`: "statement" means parts sit where the source places them (mates are solved in the viewer, which the server never sees). STEP files are physically correct whatever the document\'s unit. STL carries no unit: by default the mesh is scaled into mm (what slicers expect); `scaleTo: "document"` keeps the document\'s numbers. For STL, `resolution: "fine"` produces the cleanest mesh but is slow; default to `"medium"` unless the user asks for higher fidelity.',
      inputSchema: {
        ...workspaceArg,
        format: z.enum(['step', 'stl']).describe('Output format.'),
        shapeIds: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe('Shape ids to export (from `list_shapes` or `get_scene_summary`). Omit when passing `assembly: true`.'),
        assembly: z
          .boolean()
          .optional()
          .describe('Export the whole current assembly instead of listed shapes. Requires an open *.assembly.js file.'),
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
        scaleTo: z
          .enum(['mm', 'document'])
          .optional()
          .describe('STL only. "mm" (default) scales the mesh into millimetres for slicers; "document" keeps the document\'s units.'),
      },
    },
    async ({ workspace, format, shapeIds, assembly, saveAsPath, resolution, includeColors, scaleTo }) =>
      toMcp(
        await exportShapes({
          workspace,
          format,
          shapeIds,
          assembly,
          saveAsPath,
          resolution,
          includeColors,
          scaleTo,
        }),
      ),
  );

  server.registerTool(
    'pack_model',
    {
      title: 'Package the current model into a shareable .fluidpkg archive',
      description:
        'Produces a self-contained .fluidpkg (zip) capturing the current `.fluid.js` entry as an esbuild ES module bundle, any STEP assets in the workspace (as raw bytes), the live param overrides, and the latest camera state. Inside the archive: `manifest.json` (schemaVersion 3: `name`, `entry`, `fluidcadVersion`, `hasInit`, `unit` — the project unit from fluidcad.json, `fileUnits` — per-file `unit()` declarations, `assets`, `files`, `params`, `camera`), `bundle.js`, optional `init.js`, `assets/<path>` and `files/<path>` entries. Prefer `saveAsPath` — the binary payload can be multi-MB and shouldn\'t round-trip through the agent\'s context as base64. Returns `{ savedTo, bytesWritten, packageName }` when saved, or `{ mimeType, base64, bytes, packageName }` otherwise.',
      inputSchema: {
        ...workspaceArg,
        name: z.string().optional().describe('Optional package name; defaults to the entry file basename. Becomes the file name when `saveAsPath` is omitted.'),
        description: z.string().optional().describe('Optional human description embedded in manifest.json.'),
        saveAsPath: z
          .string()
          .optional()
          .describe('Absolute path to write the .fluidpkg to. If omitted, the package is returned inline (base64).'),
      },
    },
    async ({ workspace, name, description, saveAsPath }) =>
      toMcp(await packModel({ workspace, name, description, saveAsPath })),
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
 *
 * Payloads are serialized compact: indentation was a third of every result
 * and the agent never reads whitespace.
 */
function toMcp<T>(result: ToolResult<T>) {
  if (result.ok === true) {
    const data = result.data as any;
    // Image results are rendered as MCP `image` blocks so multimodal clients
    // can display the PNG inline without burning the agent's text budget.
    if (data && typeof data === 'object' && data.image && typeof data.image.base64 === 'string') {
      const { image, ...rest } = data;
      const imageBlock = {
        type: 'image' as const,
        data: image.base64,
        mimeType: image.mimeType ?? 'image/png',
      };
      // A result that is only a picture (the screenshot tools) is one image
      // block; one that carries a picture beside data (measure with `image`)
      // is the data first, then the picture.
      if (Object.keys(rest).length === 0) {
        return { content: [imageBlock] };
      }
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(rest) },
          imageBlock,
        ],
      };
    }
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(result.data) },
      ],
    };
  }
  const failure = result as Extract<ToolResult<T>, { ok: false }>;
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ code: failure.code, message: failure.message, details: failure.details }),
      },
    ],
  };
}

export { z };
