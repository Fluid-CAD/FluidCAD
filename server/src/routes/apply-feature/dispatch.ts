// POST /apply-feature: validate the request-wide fields, then hand the body to the feature branch it names.

import type { Router } from 'express';
import { normalizePath } from '../../normalize-path.ts';
import { validateSketchLoc, type SketchLoc } from './locations.ts';
import { validateNewVariables } from './validate/common.ts';
import { handleStatementEdit } from './handlers/statement-edit.ts';
import { handleExtrude } from './handlers/extrude.ts';
import { handleRib } from './handlers/rib.ts';
import { handleSweep } from './handlers/sweep.ts';
import { handleWrap } from './handlers/wrap.ts';
import { handleRevolve } from './handlers/revolve.ts';
import { handleHelix } from './handlers/helix.ts';
import { handleLoft } from './handlers/loft.ts';
import { handlePlane } from './handlers/plane.ts';
import { handleRepeat } from './handlers/repeat.ts';
import { handleCopy } from './handlers/copy.ts';
import { handleMirror } from './handlers/mirror.ts';
import { handleRotate } from './handlers/rotate.ts';
import { handleBoolean } from './handlers/boolean.ts';
import { handlePlaneSketch } from './handlers/plane-sketch.ts';
import { handleProject } from './handlers/project.ts';
import { handleConnector } from './handlers/connector.ts';
import { handleExpose } from './handlers/expose.ts';
import { handleSketchEntities } from './handlers/sketch-entities.ts';
import { handleSelectorFeature } from './handlers/selector-feature.ts';
import type { ApplyFeatureRequestContext, ApplyFeatureServices } from './context.ts';

export function registerApplyFeatureEndpoint(router: Router, services: ApplyFeatureServices): void {
  // Synthesize the selector expressions for the picked edges and relay the
  // edit spec to the editor extension, which owns the live buffer.
  // `preview: true` runs synthesis only (backs the expression field);
  // `selectorOverride` replaces the argument list with user-edited text.
  router.post('/apply-feature', async (req, res) => {
    const { feature, value, preview, selectorOverride } = req.body ?? {};

    // Declarations a dialog expression field committed (`myVar = 50`) —
    // written directly before the statement by the transform.
    const nvResult = validateNewVariables(req.body?.newVariables);
    if ('error' in nvResult) {
      res.status(400).json({ error: nvResult.error });
      return;
    }
    const newVariables = nvResult.newVariables;

    // The timeline's active part: the part() statement whose callback body
    // receives the created statement when nothing else pins a scope. Only the
    // producer-less creates (pick-less sketch, standard-only plane,
    // standard-axis helix) forward it — a producer-carrying spec inserts in
    // its producers' scope regardless, so the field would be inert there.
    let activePartLoc: SketchLoc | null = null;
    if (req.body?.activePart !== undefined && req.body?.activePart !== null) {
      activePartLoc = validateSketchLoc(req.body.activePart);
      if (!activePartLoc) {
        res.status(400).json({ error: 'activePart must be {filePath, line, column} of the part statement' });
        return;
      }
    }
    // Cross-file guard: a stale active part from another buffer never
    // redirects an insertion in this one.
    const activePartFor = (filePath: string | null): { line: number; column: number } | undefined =>
      activePartLoc && filePath !== null
        && normalizePath(activePartLoc.filePath) === normalizePath(filePath)
        ? { line: activePartLoc.line, column: activePartLoc.column }
        : undefined;

    const ctx: ApplyFeatureRequestContext = {
      ...services, feature, value, preview, selectorOverride, newVariables, activePartLoc, activePartFor,
    };

    // In-place statement edit (timeline double-click → edit dialog): the
    // statement at the location is re-parsed from the live buffer and its
    // dialog options replaced. Re-sourced slots (re-picked selections,
    // profiles, paths) synthesize selectors against the scene truncated to
    // the `before` boundary — the world the statement's arguments see.
    if (req.body?.edit !== undefined && req.body?.edit !== null) {
      await handleStatementEdit(ctx, req, res);
      return;
    }

    // Extrude's profile is a sketch statement, never a pick selection — the
    // transform re-verifies that the line holds a sketch() call. The optional
    // up-to-face target replaces the distance(s) as the call's first
    // argument: a picked face synthesizes a face selector, while
    // 'first-face'/'last-face' render as that literal — no pick involved,
    // the kernel resolves the face at build time.
    if (feature === 'extrude') {
      await handleExtrude(ctx, req, res);
      return;
    }

    if (feature === 'rib') {
      await handleRib(ctx, req, res);
      return;
    }

    // Sweep composes a profile sketch with a path (a second sketch, or edge
    // picks synthesized into a selector) — no shared pick validation applies.
    if (feature === 'sweep') {
      await handleSweep(ctx, req, res);
      return;
    }

    // Wrap composes a sketch with a picked target face (synthesized into a
    // face selector). The sketch is always bound to a variable — wrap() takes
    // it as an explicit argument, never consuming the active sketch.
    if (feature === 'wrap') {
      await handleWrap(ctx, req, res);
      return;
    }

    // Revolve composes a profile sketch around an axis — a standard world
    // axis, an existing axis statement bound to a variable, or a picked edge
    // synthesized into `axis(<selector>)`.
    if (feature === 'revolve') {
      await handleRevolve(ctx, req, res);
      return;
    }

    // Helix builds a wire around an axis (a standard world axis, an existing
    // axis statement bound to a variable, or a picked edge synthesized into
    // `axis(<selector>)`) or on a cylindrical/conical face (its selector on
    // its own). It consumes no sketch, so there is no profile producer.
    if (feature === 'helix') {
      await handleHelix(ctx, req, res);
      return;
    }

    // Loft takes an ordered list of profiles — sketches and picked faces
    // mixed freely. Face picks run synthesis ONE AT A TIME: the kernel groups
    // picks by (producer, bucket), so a batched call would merge same-bucket
    // faces into one part and destroy profile order and arity.
    if (feature === 'loft') {
      await handleLoft(ctx, req, res);
      return;
    }

    // Plane takes one base (offset) or two (mid) — standard planes, picked
    // faces/edges, or existing plane features, mixed freely. Picks run
    // synthesis one at a time like loft profiles, so each base keeps its own
    // selector part.
    if (feature === 'plane') {
      await handlePlane(ctx, req, res);
      return;
    }

    // Repeat replays one or more timeline features linearly, circularly,
    // mirrored, or rotated. The targets are feature statements bound to
    // variables; every axis reuses the revolve axis inputs (a picked edge
    // synthesizes `axis(<selector>)` — one selector part per direction),
    // the mirror plane the plane-base inputs (a picked face synthesizes
    // `plane(<selector>)`).
    if (feature === 'repeat') {
      await handleRepeat(ctx, req, res);
      return;
    }

    if (feature === 'copy' && req.body?.sketchEntities === undefined) {
      await handleCopy(ctx, req, res);
      return;
    }

    // The 3D mirror; the in-sketch form rides the sketchEntities branch below.
    if (feature === 'mirror' && req.body?.sketchEntities === undefined) {
      await handleMirror(ctx, req, res);
      return;
    }

    if (feature === 'rotate') {
      await handleRotate(ctx, req, res);
      return;
    }

    if (feature === 'boolean') {
      await handleBoolean(ctx, req, res);
      return;
    }

    // A pick-less sketch: no face selector — a sketch on an origin plane or
    // an existing plane() feature, appended after the file's last statement.
    // No synthesis is involved; `plane` picks an origin target
    // ('xy'/'xz'/'yz'), `planeRef` an existing plane statement by call site
    // (bound to a variable — `sketch(p, () => {})`), absent defaults to xy.
    if (feature === 'sketch' && Array.isArray(req.body?.entities) && req.body.entities.length === 0) {
      await handlePlaneSketch(ctx, req, res);
      return;
    }

    // Project is the hybrid branch: the picks are ordinary 3D edges and faces
    // (synthesized like a fillet's), but the statement lands inside the body
    // of the sketch named by `sketch` — `project()` reads the sketch it is
    // called from. The transform binds the producers where they already live.
    if (feature === 'project') {
      await handleProject(ctx, req, res);
      return;
    }

    // Named connector (part files): the single pick is the connector's source
    // face/edge and `name` is the identifier the statement registers. The
    // kernel stamps the name and the enclosing part() call site into the
    // spec; the transform lands the statement inside that part's callback
    // body, before a trailing return.
    if (feature === 'connector') {
      await handleConnector(ctx, req, res);
      return;
    }

    // Named exposure (part files): the single pick is the exposure's source
    // face/edge and `name` is the identifier the statement registers under
    // `def.features.<name>`. Same rails as the connector arm — the kernel
    // stamps the name and the enclosing part() call site into the spec, the
    // transform lands the statement inside that part's callback body — minus
    // the frame adjustments (an exposure has no anchor/rotate/offset).
    if (feature === 'expose') {
      await handleExpose(ctx, req, res);
      return;
    }

    // Sketch-edge picks (2D branch): 1 shapeId = 1 sketch edge, no sub refs.
    // Synthesis resolves them through the sketch edge index and the emitted
    // statement lands inside the sketch body via the same edit-spec transform.
    if (req.body?.sketchEntities !== undefined) {
      await handleSketchEntities(ctx, req, res);
      return;
    }

    await handleSelectorFeature(ctx, req, res);
  });
}
