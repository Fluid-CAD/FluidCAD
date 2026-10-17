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
  packPackage,
  recompute,
  rollbackTo,
} from './tools/engine.ts';
import { loadDocsIndex, type DocsIndex } from './docs-index.ts';
import { loadSkillsIndex, type SkillsIndex } from './skills-index.ts';
import { registerSkillsExtension, skillsExtensionCapability } from './skills-extension.ts';
import { listSkills, readSkill } from './tools/skills.ts';
import { registerDocResources, registerSkillResources } from './resources.ts';
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
  /** Pre-built skills index. Tests use this to inject a custom skills root. */
  skillsIndex?: SkillsIndex;
};

export function buildServer(options: BuildServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        // MCP SEP-2640 Skills Extension: skills/list, skills/get and
        // resources/directory/read over the skill:// resources.
        extensions: skillsExtensionCapability(),
      },
      instructions: [
        'Drives a running FluidCAD workspace.',
        'Call list_workspaces first to find available workspaces.',
        'Use list_docs/search_docs/read_doc/get_api_signature to learn the API.',
        '',
        'The FluidCAD workflow skills ship with this server and always match',
        'its version. Unless your client has already loaded a FluidCAD skill,',
        'load skill://fluidcad/SKILL.md before modeling and follow it; add',
        'skill://fluidcad-from-drawing/SKILL.md when the geometry comes from a',
        'drawing or image, skill://fluidcad-assembly/SKILL.md when more than',
        'one part is involved, and skill://fluidcad-custom-features/SKILL.md',
        'when a feature type (a *.feature.js module), not a part, is being',
        'written. Clients without skill support read them',
        'with read_skill("fluidcad") etc.; a skill\'s supporting files',
        '(references/*.md, scripts/*) load with read_skill(name, file).',
        'list_skills lists them all.',
        'When a signature mentions an unfamiliar type (e.g. PlaneLike, AxisLike,',
        'SceneObject, LinearRepeatOptions), call get_type_definition with the',
        'type name to resolve its accepted forms / methods / properties.',
        'All paths are workspace-absolute.',
        '',
        'Every sketch is fully constrained. `sketch(plane, cb)` takes exactly',
        'two arguments (there is no mode flag); inside the callback, draw',
        'primitives at guess positions, then pin every entity (to origin() /',
        'xAxis() / yAxis(), a project() reference, or another entity) and',
        'dimension every size with constraints from "fluidcad/constraints"',
        'until the solver reports the sketch fully constrained. Coordinate',
        'literals are guesses, never the design.',
        '',
        'Do not build features inside a `for` loop (or forEach/map). Features',
        'made in a loop are hard to edit from the FluidCAD UI. Build the',
        'feature once and place the rest with repeat() ("linear", "circular",',
        '"mirror", "rotate"; a repeat can repeat a repeat; `skip` leaves slots',
        'out) or copy() for independent duplicates of a finished shape.',
        'Instances that differ in size are separate statements. Loop only when',
        'none of these can express the geometry.',
        '',
        '`.name(\'…\')` on a feature statement is optional: the UI writes it for',
        'statements it creates, an unnamed feature shows as `<Type> <n>`',
        '("Extrude 2") in the timeline and in get_scene_summary, and you may',
        'name the features you want to refer to later.',
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
        'A `*.feature.js` module defines a custom feature (fluidcad/sdk) that',
        'models import and call. Writing a file that is not a model (.fluid.js,',
        '.part.js, .assembly.js) never renders that file as the model: a',
        'JavaScript module (or fluidcad.json) re-renders the open model in full',
        'with its new contents (`render.openModel: true`), so render the model',
        'that uses a feature (write it) before editing the feature module.',
        'read_doc "concepts/custom-features" explains custom features.',
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
        'Returns every running FluidCAD workspace on this machine (from ~/.fluidcad/instances.json), with a quick liveness probe per entry. `reachable: false` is a dead server; `busy: true` is a live one that is mid-render — it is reachable, and a request sent to it waits for the render to finish.',
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

  const skillsIndex = options.skillsIndex ?? loadSkillsIndex();

  server.registerTool(
    'list_skills',
    {
      title: 'List the FluidCAD workflow skills',
      description:
        'Returns every workflow skill bundled with this server (fluidcad, fluidcad-from-drawing, fluidcad-assembly, fluidcad-custom-features) with its name, trigger description, skill:// uri, and file list. These are the same skills `npx skills add Fluid-CAD/FluidCAD` installs, served at the version matching this server. Use read_skill to load one.',
      inputSchema: {},
    },
    async () => toMcp(listSkills(skillsIndex)),
  );

  server.registerTool(
    'read_skill',
    {
      title: 'Read a FluidCAD workflow skill',
      description:
        'Returns a skill\'s SKILL.md (frontmatter stripped) and its file list, or with `file` one of its supporting files (e.g. "references/traps.md"). Read "fluidcad" before modeling unless your client already loaded the skill; follow it as instructions.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe('Skill name from list_skills: "fluidcad", "fluidcad-from-drawing", "fluidcad-assembly" or "fluidcad-custom-features". Case-insensitive.'),
        file: z
          .string()
          .optional()
          .describe('Path relative to the skill directory, e.g. "references/traps.md". Defaults to SKILL.md.'),
      },
    },
    async ({ name, file }) => toMcp(readSkill(skillsIndex, { name, file })),
  );

  registerSkillResources(server, skillsIndex);
  registerSkillsExtension(server, skillsIndex);

  const workspaceArg = {
    workspace: z
      .string()
      .optional()
      .describe(
        'Absolute workspace path of the target FluidCAD instance. Optional when only one workspace is running.',
      ),
  };

  const shapeIdArg = z
    .string()
    .min(1)
    .describe(
      'Shape id from list_shapes or get_scene_summary. Ids are minted afresh whenever the holding feature rebuilds, so re-read them after an edit; ' +
      'to find the same body again use its `lineageKey` (stable across your own edits) or its `label` + `part` ("Solid 2" of "Bracket", as the Shapes panel lists it).',
    );
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
        'Returns a JSON projection of the current scene: every scene object with its index, id, kind, parameters, source location, and the shape ids it produced, plus `unit` — the document unit (mm/cm/m/in/ft) every length in the parameters is in. `name` is the object\'s display label — the text of its `.name(\'…\')` chain when `hasCustomName` is true, else the default `<Type> <n>` ("Extrude 2") the timeline shows; `.name()` is optional and the UI writes it for statements it creates. `shapes` lists the same shapes as `shapeIds` with `label` + `part` ("Solid 2" of "Bracket", the Shapes panel\'s row; `part` null = the top-level "Model" group) and, for solids, `lineageKey` — the body\'s identity across renders, stable through your own edits where `shapeId` is not. A `part` object also carries `material` (the id its `.material()` assigned, or null) and, when that id is in neither the built-in nor the project materials table, `warnings: ["Unknown material: <id>"]` — the part still built; only its mass is unknown. Use this before list_shapes when you need feature-tree context. ' +
        'In an assembly file it also returns `instances`, one per inserted instance (sub-assemblies\' included): `instanceId` (what ' +
        'validate, interfere, measure, resolve_selection and the screenshot `hide`/`focus`/`fitTo` take), `name`, `partId`/`partName` ' +
        '(the `part` row it inserts; `partId` feeds get_shape_properties), `owner` (the sub-assembly occurrence path, "" at the root), ' +
        '`grounded` (fixed in the world), `shapeIds` (the rendered solids it shows, the same ids for every instance of one part: what ' +
        'validate checks and interfere places for it), `pose`, `sourceLocation`, and `replica` on a replicate() copy. `instancePoses` ' +
        'says what every `pose` is: { frame: "world", source: "statement" }, the insert() chain\'s translate/rotate composed through ' +
        'sub-assembly frames, the pose interfere, measure and resolve_selection use by default. It is NOT the mate-solved pose the ' +
        'viewport draws: mates are solved only in the viewer, and no tool reports that pose. Each `pose` is already an interfere ' +
        '`poses` entry ({ instanceId, position, quaternion }). `occurrences` lists inserted sub-assemblies (`occurrenceId`, `name`, ' +
        '`assemblyName`, `parentPath`). A part file has none of these keys.',
      inputSchema: workspaceArg,
    },
    async ({ workspace }) => toMcp(await getSceneSummary({ workspace })),
  );

  server.registerTool(
    'list_shapes',
    {
      title: 'List all shapes in the current scene',
      description:
        'Returns a flat list of `{ shapeId, type, sceneObjectId, label, part, lineageKey? }`: `label` + `part` is the row the Shapes panel shows ("Solid 2" of "Bracket"; `part` null = the top-level "Model" group; both absent on a meta shape), `lineageKey` (solids only) stays the same across your own edits where `shapeId` is minted afresh. Cheaper than get_scene_summary when you only need ids — use this before calling shape/face/edge property tools.',
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
      title: 'Get geometric properties of a shape or a part',
      description:
        'With `shapeId`: volume, surface area, and center of mass for a single shape. With `partId` (a `part` object id from get_scene_summary, or an assembly instance\'s `partId`) instead: the same summed over the part\'s final solids (`shapeIds`, `solidCount`, volume-weighted `centroid`), plus `material` (id, name, density, `densityGcm3`, `source` built-in|project) and `massG` in grams when the part\'s `.material(id)` resolves, or `warning: "Unknown material: <id>"` and no mass when it does not; `material` is null for a part without one. Values are in the document unit, returned as `unit` (the `volumeMm3`/`surfaceAreaMm2` field names are historical — an inch document reports in³/in² under them; `massG` is always grams).',
      inputSchema: {
        ...workspaceArg,
        shapeId: shapeIdArg.optional(),
        partId: z.string().min(1).optional().describe('A part object id from get_scene_summary (kind "part") — sums its final solids; pass this OR shapeId.'),
      },
    },
    async ({ workspace, shapeId, partId }) =>
      toMcp(await getShapeProperties({ workspace, shapeId, partId })),
  );

  server.registerTool(
    'get_face_properties',
    {
      title: 'Get geometric properties of a face',
      description:
        'Returns the surface kind and size of a single face on a shape, as `surfaceType` plus that kind\'s fields: plane (`areaMm2`); circle, a flat face bounded only by circular edges (`radius`, no area); cylinder (`radius`, and `closed` — true when it wraps fully around its axis like a bore or a boss wall, false for a fillet or a partial wall); sphere (`radius`); torus (`majorRadius`, `minorRadius`); cone (`halfAngleDeg`); other (`areaMm2`). It returns no normal, center or axis, and no area for a circle or a curved analytic face: resolve_selection with `picks: [{ shapeId, kind: "face", index: faceIndex }]` summarizes the face with its center, normal (a planar face\'s points out of its solid) or axis, and area. Lengths and areas are in the document unit, returned as `unit` (`areaMm2` is a historical field name).',
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
      z.object({ instanceId: z.string().min(1).describe('Assembly files: an instance id from get_scene_summary (`instances[].instanceId`).') }),
    ])
    .optional()
    .describe(
      'Where the expression is evaluated. Omitted: root scope — the whole scene, as a root-level select() sees it. ' +
      '{ sceneObjectId } or { part }: only that part\'s own geometry, exactly what a select() inside part("name", ...) sees ' +
      '(a filter scoped to part "base" never matches faces of part "pillar"). { instanceId }: that instance\'s part build, ' +
      'matches carrying instanceId and the statement pose (the `pose` get_scene_summary reports for the instance) so they feed ' +
      'measure unchanged.',
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
    shapeId: z.string().min(1).describe('Shape id from list_shapes / get_scene_summary / hit_test.'),
    kind: z.enum(['face', 'edge', 'vertex']),
    index: z.number().int().nonnegative().describe('Topological face/edge/vertex index in that shape; vertex indices follow the rendered vertices payload.'),
  });

  server.registerTool(
    'resolve_selection',
    {
      title: 'Resolve a selection and synthesize the selector to write for it',
      description:
        'Two inputs, one of them: `expression` — a filter expression evaluated with exactly the candidate set a select() statement ' +
        'would see at the given scope; or `picks` — explicit face/edge/vertex refs (from hit_test, the rendered topology, or an earlier ' +
        'match). Returns every match with its shapeId/kind/index (faces/edges are usable in measure and hit_test), owning ' +
        'sceneObjectId and part, and a compact summary: form (plane/cylinder/cone/sphere/torus/surface or line/circle/arc/ellipse/curve), ' +
        'center [x,y,z], normal (a planar face\'s points out of its solid) or axis, area or length, diameter for ' +
        'cylinders/spheres/circles. Lengths are in the document unit ' +
        '(returned as `unit`), rounded to its meaningful precision. Vertex summaries have form vertex and a world-space center; ' +
        'vertex source synthesis is not yet available. Zero matches is a normal result with count 0 — check it before ' +
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
        'no solid at all); `nonFiniteGeometry` (unbounded/non-finite geometry bounds or signed volume). Self-intersection is NOT checked ' +
        'by this basic inspection, as stated under `notChecked`; expensive native self-interference analysis is reserved for ' +
        'explicit diagnostics. Do not infer a self-interference verdict from this report. Result: `ok` (true only with zero ' +
        'findings), `checked` (shapes examined), `findings`, `shapes` (per shape: faces, edges, solids, signed `volume` in the ' +
        'document unit cubed, finding kinds), `skipped` (shapes that could not be examined, with why), `checks` (what ran), `unit`. ' +
        'Default is every solid the scene renders (a solid a later cut consumed is not rendered, so not checked). `shapeIds` ' +
        'narrows to those shapes — and lets you name a non-solid shape, which reports `noSolid`. In an assembly, instances of one ' +
        'part share its prototype: each shape is checked once and `instanceIds` lists every instance showing it; `instanceId` ' +
        'narrows to that instance\'s part (get_scene_summary lists those solids as the instance\'s `shapeIds`). An unknown shape ' +
        'or instance, or no rendered scene, is an error naming the problem.',
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
          .describe('Assembly files: only the shapes of this instance\'s part prototype (`instances[].instanceId` from get_scene_summary; that entry\'s `shapeIds` are the solids checked).'),
      },
    },
    async ({ workspace, shapeIds, instanceId }) =>
      toMcp(await validate({ workspace, shapeIds, instanceId })),
  );

  const instancePoseArg = z.object({
    instanceId: z.string().min(1).describe('The instance this pose is for. get_scene_summary\'s `instances[].pose` is already this shape: { instanceId, position, quaternion }.'),
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
        'at their STATEMENT poses: insert().translate()/.rotate() composed through sub-assembly frames, in the world. That is the ' +
        '`pose` get_scene_summary reports per instance, so passing those back unchanged gives the same result. Mates are solved only ' +
        'in the viewer and no tool reports the solved pose: a mated instance is checked where its statement puts it. A viewport drag ' +
        'writes the dragged instance\'s pose back onto its statement, so later checks read it. `poses` (world poses, each shaped like ' +
        'get_scene_summary\'s `instances[].pose`) places instances elsewhere for this check only, e.g. at a pose you computed from ' +
        'the mate geometry. `instanceIds` with one id tests that instance against every other body; with two or more, only the ' +
        'named instances among themselves. ' +
        '`shapeIds` narrows to those shapes (every instance showing them). An unknown shape or instance, or no rendered scene, is an ' +
        'error naming the problem.',
      inputSchema: {
        ...workspaceArg,
        instanceIds: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe('Assembly files: one id tests that instance against everything; two or more test only the named instances among themselves (`instances[].instanceId` from get_scene_summary).'),
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
          .describe('Assembly files: world poses to use instead of the statement poses, per instance. Each entry has the shape of get_scene_summary\'s `instances[].pose`, which holds the statement pose itself.'),
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
      z.object({
        kind: z.literal('section'),
        straight: z.boolean().optional().describe('Look square-on along the cut normal, like a drawing\'s section A-A. Default false: tilted about 32° toward up and to the right, so the kept half\'s depth reads too.'),
      }).describe('Looks at the capture\'s `section` from the removed half, where the cut face points — the default whenever a section is given without a view. Needs `section`.'),
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
        'Assembly files only: the inserted instance the entity belongs to (`instances[].instanceId` from get_scene_summary). ' +
        'Instances of one part share a shapeId, and the entity is measured at the instance\'s statement pose: the world `pose` ' +
        'get_scene_summary reports for it (insert() translate/rotate, through sub-assembly frames). The mate-solved pose the ' +
        'viewport draws is not applied.',
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
  const fitMarginArg = z
    .number()
    .min(1)
    .max(10)
    .describe(
      'The frame\'s size as a multiple of what the shapes cover on screen, on the tighter axis: 1 puts them flush with the frame edge, ' +
      'the default 1.2 leaves a small margin (they fill about 83% of it), 2 makes them half the frame. 1-10.',
    );
  const sectionArg = z
    .object({
      plane: z
        .union([
          z.enum(['xy', 'yz', 'xz']).describe('A world datum plane through the origin: xy (normal +Z), yz (normal +X) or xz (normal +Y).'),
          z.object({
            origin: vec3.describe('A point on the cut plane, document units.'),
            normal: vec3.describe('The plane normal; it points at the half that is removed.'),
          }).describe('An explicit plane.'),
          z.object({
            sceneObjectId: z.string().min(1).describe('The id of a plane() or section() statement, from get_scene_summary.'),
          }).describe(
            'The plane a statement built: a plane() feature (its origin and normal), or a section() view — its saved cut, own offset and flip ' +
            'included; `offset` here moves that cut further and `flip` overrides.',
          ),
          z.object({
            shapeId: shapeIdArg,
            kind: z.literal('face').optional(),
            index: z.number().int().nonnegative().describe('Zero-based face index inside the shape.'),
            instanceId: z.string().min(1).optional().describe('Assembly files only: the inserted instance the face belongs to; the plane is read where the instance sits per its insert() statement.'),
          }).describe('A planar face by index, as measure addresses it. Its outward normal points away from the solid, so a bare face cut shows the face itself: pass a negative `offset` to cut into the part, or `flip` to keep the outside.'),
          z.object({
            expression: z.string().min(1).describe('FluidCAD filter syntax matching exactly one planar face, e.g. face().onPlane("xy", 30); several matches are refused with the candidates listed.'),
            scope: selectionScopeArg.optional(),
          }).describe('A planar face by filter expression, scoped as in measure; the same normal rule as a face by index.'),
        ])
        .describe('The cut plane: a named datum plane, an explicit { origin, normal } (document units), a planar face (by index or filter) or a plane()/section() statement by id.'),
      offset: z.number().optional().describe('Moves the cut plane along its normal, document units (default 0). { plane: "xy", offset: 10 } cuts at z = 10; on a face, a negative offset cuts into the part.'),
      flip: z.boolean().optional().describe('Keep the other half: the side the normal points at stays and the far side is removed.'),
    })
    .optional()
    .describe(
      'Section (cut-away) view, document units. The model is cut on the plane and the half the normal points at is removed, so the ' +
      'picture shows the cut from the normal\'s side; by default the far half (the side the normal points away from) is kept. Cut ' +
      'faces are capped as the viewport\'s section view caps them — hatched, each body in its own colour — so solids read solid, ' +
      'holes read hollow and the bodies of a fit read apart; highlights are clipped with the model. With no `view` the capture looks ' +
      'at the cut (view kind "section"); a named view can face the kept half and show no cut. ' +
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
    hide: idListArg.optional().describe('Shape ids (get_scene_summary `objects[].shapeIds` / `instances[].shapeIds`) or assembly instance ids (`instances[].instanceId`) left out of the render. In an assembly a part\'s shape id reaches every instance of that part; an instance id reaches one instance. Exclusive with focus.'),
    focus: idListArg.optional().describe('Shape ids or instance ids (as for hide) kept as they are while everything else is ghosted in place (faint, silhouettes kept) so the context stays. Exclusive with hide.'),
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
      .union([
        z.literal('highlight').describe('Frame the highlighted entities\' combined bounding box (plus annotation points). Needs highlight.'),
        z.object({
          shapes: idListArg.describe('Shape ids (from list_shapes / get_scene_summary) or assembly instance ids (get_scene_summary `instances[].instanceId`) to frame.'),
          margin: fitMarginArg.optional(),
        }).describe('Frame these shapes/instances as the page draws them (assembly instances where their pose puts them). Framing only: nothing is hidden or ghosted. An id the current render does not hold is an error.'),
      ])
      .optional()
      .describe(
        'Frame something other than the whole model, from the view\'s direction: "highlight" frames the highlighted geometry, ' +
        '{ shapes, margin? } frames the given shapes the way screenshot_shape frames one.',
      ),
    section: sectionArg,
  };

  const measureImageArg = z
    .object({
      view: screenshotViewArg.optional().describe('Defaults to the iso-ftr named view, or to the section view when `section` is given.'),
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
        'Renders the current FluidCAD scene to a PNG using a stateless camera view. The user\'s interactive camera is never moved. `view` defaults to the agent\'s last seen camera state — or, with `section`, to the section view that looks at the cut — pass a `named` view (e.g. {kind:"named", name:"iso-ftr"}) for "show me from the front-top-right" or `look-from` for a precise vantage. ' +
        '`highlight` draws faces/edges (by index or filter expression) through occluders, `hide`/`focus` drop or ghost other shapes, `annotations` add labelled lines, `fitTo` frames the highlighted geometry ("highlight") or given shapes/instances ({ shapes }) instead of the whole model, and `section` cuts the model away on one side of a plane — a datum, a planar face or a plane() statement — with the cut faces capped and hatched, to show bores, blind holes and walls. Returns an MCP image content block.',
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
        '(two opposed isometrics show every face in at least one cell), top and front; with `section` and no `views`, the tilted section view beside the square-on one. ' +
        'Pass `views` for other vantages (named, look-from, orbit-from-current, section). ' +
        'Use this to "see all sides at once" without several tool calls; the overlay options (highlight, hide, focus, annotations, fitTo, section) apply to every cell. The user\'s interactive camera is never moved.',
      inputSchema: {
        ...workspaceArg,
        views: z
          .array(screenshotViewArg)
          .min(2)
          .max(6)
          .optional()
          .describe('The cells\' views, 2-6, row-major two per row. Default: iso-ftr, iso-bbl, top, front — or, with `section`, {kind:"section"} and {kind:"section", straight:true}.'),
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
        'Renders a PNG of one shape from the iso-ftr view, framed by the page as it draws the shape (fitTo: { shapes: [shapeId], margin }) with a small margin, so in an assembly an instance\'s shape is framed where its pose puts it. ' +
        'The rest of the scene is drawn as it is (pass focus or hide to ghost or drop it). Useful for "show me this specific feature" requests. ' +
        'Takes the same highlight/hide/focus/annotations/section overlays as screenshot; with `section` the capture looks at the cut (view kind "section") instead of the iso vantage, still framed on the shape. Your own fitTo wins over the shape framing (margin is then refused: put it in fitTo.margin). ' +
        'A shapeId the current render does not hold is an error (HTTP 404, unknown-shape): take ids from list_shapes or get_scene_summary.',
      inputSchema: {
        ...workspaceArg,
        shapeId: shapeIdArg,
        margin: fitMarginArg.optional(),
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
      title: 'List every FluidCAD file in the workspace',
      description:
        'Walks the workspace recursively and returns workspace-relative paths for every FluidCAD file: the models (`.fluid.js`, `.part.js`, `.assembly.js`) and the custom feature modules they import (`.feature.js`). Skips `node_modules`, `.git`, `.fluidcad`, `dist`, `build` and other dot directories.',
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
        'Writes `content` to `path` (UTF-8, tmp+rename atomic), then synchronously triggers a render and returns the outcome under `render` (`state`: rendered | build-error | compile-error | superseded | no-scene-manager | render-failed, plus `version`, `durationMs`, optional `compileError`). `render.uiApplied` is true once a connected viewer has the render on screen — false means built but not (yet) visible: no viewer is connected, or it is still applying the scene. `build-error` means the file ran but one or more features failed to build — `render.objectErrors` lists each one (`name`, `uniqueKind`, `message`, 1-based `sourceLocation`) and the scene is missing their geometry; only `rendered` means the model matches the source. `render.changes` (unless `includeChanges: false`) says what the render actually rebuilt: `rebuilt` (objects built again, each with `sceneObjectId`, `name`, `kind`, `sourceLocation`, `shapes` and exact `bounds.before` / `bounds.after` of its solids — volumes are not included), `added`, `removed`, `reused` (count served from cache, geometry untouched) and `truncated` when a list hit its 50-entry cap. Re-verify the rebuilt objects; an object you did not mean to touch appearing under `rebuilt` with different bounds is an unintended downstream change. For FluidCAD script files (`.fluid.js`, `.part.js`, `.assembly.js`), refuses writes that use a known FluidCAD symbol without an `import { … } from "fluidcad/…"` line — fails with code `missing-imports` and `details.suggestion` shows the imports to add — and writes whose `unit()` statement breaks a placement rule (must be top-level, before any geometry, once per file, a string literal, never in a `*.assembly.js` file) — fails with code `unit-statement` and `details.diagnostics` lists each violation with its 0-based line. Also refuses to clobber a file the editor extension reports as dirty — fails with code `dirty-buffer` whose `details.dirtyFiles` lists every dirty path. Pass `force: true` to override either guard. Only a model file renders itself. Any other file is never rendered as the model: a JavaScript module the open model may import (a `*.feature.js` custom feature, a helper) or `fluidcad.json` re-renders the open model in full instead, so new feature code takes effect — `render` then carries `openModel: true` with `state` (rendered | build-error), `objectErrors` and `changes` (every object rebuilt), or `state: no-open-model` when no model is open, or `render-failed` with the error the model hit; any other file (an icon, a note) re-renders nothing (`state: not-rendered`).',
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
        'Replaces the half-open range `[start, end)` in `path` with `newText`. Positions are 0-based `{ line, column }` (UTF-16 columns). End-of-line and end-of-file overrun clamp gracefully. Same dirty-buffer guard, missing-imports and unit-statement guards (for FluidCAD script files), `force` semantics, and synchronous `render` outcome (including `render.changes`: rebuilt / added / removed objects with exact before and after bounds, plus the reused count) as `write_file` — a file that is not a model re-renders the open model (`render.openModel: true`), as there.',
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
        'Discards the cached scene and re-runs the current `.fluid.js` file. Synchronous — returns once the render settles. Reports `state` (rendered | build-error) and `objectErrors` for any feature that failed to build, `uiApplied` (true once a connected viewer has the render on screen), plus `changes` (unless `includeChanges: false`): every object is `rebuilt` since nothing is cached, each with exact `bounds.before` / `bounds.after` of its solids (no volumes), so a differing pair is geometry that changed since the last render.',
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
    'pack',
    {
      title: 'Pack the workspace\'s package into a .fluidpkg archive, to look at what would be published',
      description:
        'Packs the workspace\'s package — the `package` block of its fluidcad.json (`name`, `version`, optional identity fields; no exports list) — into a `.fluidpkg` (zip), exactly as `fluidcad pack` does; run `fluidcad package init` once to make a workspace a package. The block\'s `name` is `@scope/name`, the scope being the hub handle the author publishes under (`@acme/gears`); a name without the scope is refused. It is never a step before publishing: `fluidcad publish` packs the workspace the same way itself and uploads that, so this archive is for looking at what would be published (its files, `manifest.json`, the contents) without publishing. Packages reach other projects only through the hub, and nothing installs the archive. ' +
        'The folders decide what a package exports: every `*.feature.js` in `features/`, every `*.part.js` and `*.fluid.js` in `parts/` and every `*.assembly.js` in `assemblies/`, nested folders included; plain `.js` helpers may sit in any of the three. Models import the package\'s features relatively (`../features/bolt-circle.feature.js`). ' +
        'The archive holds those modules and every file they import, verbatim; the images their features declare; README.md, LICENSE and CHANGELOG.md; and three generated files: `index.js` (named re-exports of every exported feature, part and assembly), `fluidcad.json` (only `unit` and `materials`) and `manifest.json` (`manifestVersion` 1: `name`, `version`, the optional identity fields, `engine` it was packed on, `minEngine`, `sdkVersion`, `unit` — the project unit, made explicit, `fileUnits` — per-file `unit()` declarations, `contents`, `features` with metadata snapshots, `parts` with their params, `files`; nothing records when it was packed, so the same workspace packs to the same bytes). Test models outside the three folders, `init.js` and anything not imported stay out, and nothing is written to the workspace. ' +
        'The engine evaluates every export first. The pack is refused (`pack-refused`, with a sentence naming the file and `details.code`) when the workspace has no `package` block or its block still lists `exports`; a module sits in the wrong folder for its suffix (`wrong-folder`, e.g. a `*.part.js` in `features/`); the three folders hold nothing (`no-exports`); an import leaves the three folders (`outside-layout`, e.g. a root-level `lib/x.js`); or (`refused`) an export does not evaluate, two modules export one name, two features declare one id, a part or assembly fails to build with its default parameters (any object in error), an import reaches `node_modules`, outside the workspace, `init.js`, a blocked Node built-in or another package, a declared image is missing, or a shipped file has unsaved editor changes — save first. ' +
        'A `docs/` folder ships too: markdown pages (`.md`) and the images they show (`.svg`, `.png`, `.jpg`, `.jpeg`, `.webp`), nested folders allowed; a script there is `outside-layout`, any other file type `docs-file`, and a page over 256 KB, an image over 2 MB or the folder over 4 MB or 200 files `docs-too-large`. ' +
        'Nothing is refused for missing documentation. Instead `warnings` lists what to look at, and the package still packs: `undocumented-fields` (one per module: feature values, features, and part and assembly parameters with no `description`, one that only repeats the label, or one over 1,000 characters, under `fields`) and `docs-link` (a relative link or image in a doc page that leads to no shipped file or out of the package, with `target` and `line`). ' +
        'Prefer `saveAsPath` — the archive can be large and shouldn\'t round-trip through the agent\'s context as base64. Returns `{ savedTo, bytesWritten, packageName, version, fileName, contents, warnings }` when saved, or `{ mimeType, base64, bytes, packageName, version, fileName, contents, warnings }` otherwise; `packageName` is the `package` block\'s name (`@acme/gears`), `fileName` is `<scope>-<name>-<version>.fluidpkg` (e.g. `acme-gears-1.2.0.fluidpkg`), and `contents` lists the package by folder — `features` (`id`, `exportName`, `module`), `parts` and `assemblies` (`exportName`, `name`, `module`, `params` count) `models` (parts + assemblies; publishing to the hub needs at least one) and `docs` (the doc pages), the same as `fluidcad pack --json`.',
      inputSchema: {
        ...workspaceArg,
        saveAsPath: z
          .string()
          .optional()
          .describe('Absolute path to write the .fluidpkg to (name it `fileName`, e.g. `acme-gears-1.2.0.fluidpkg`). If omitted, the archive is returned inline (base64).'),
      },
    },
    async ({ workspace, saveAsPath }) => toMcp(await packPackage({ workspace, saveAsPath })),
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
