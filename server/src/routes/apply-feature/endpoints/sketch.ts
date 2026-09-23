// Solved-sketch editing endpoints: constraints, split, trim, delete, distance tangency and solved insertion.

import type { Router } from 'express';
import type { ApplyFeatureEditSpec } from '../../../apply-feature-edit/index.ts';
import {
  applySolvedEmission,
  constraintTargetCountValid,
  sanitizeEmissionTarget,
  type SolvedConstraintEmission,
  type SolvedEmissionTarget,
  type SolvedGeometryEmission,
} from '../../../sketch-solved-edit/index.ts';
import { SOLVED_CONSTRAINT_KINDS, SOLVED_GEOMETRY_CALLEES } from '../../../sketch-symbols.ts';
import { SketchSplit, type SketchSplitSpec } from '../../../sketch-split.ts';
import { SketchTrim, type SketchTrimSpec } from '../../../sketch-trim.ts';
import { SketchEntityDelete, type SketchDeleteSpec } from '../../../sketch-entity-delete.ts';
import { validateSketchPositionEdits } from '../../../sketch-position-validate.ts';
import {
  SketchEntitySplit,
  SplitRefusal,
  type SplitPiece,
  type SplitPoint,
} from '../../../../../lib/dist/features/2d/split.js';
import { validateNewVariables } from '../validate/common.ts';
import {
  assignHints,
  sanitizeCutHints,
  sanitizeCutters,
  sanitizeSplitPoint,
  sanitizeSplittableEntity,
} from '../validate/sketch-split.ts';
import type { ApplyFeatureServices } from '../context.ts';

export function registerSketchEndpoints(router: Router, services: ApplyFeatureServices): void {
  const { fluidCadServer, dispatcher } = services;

  // Solved-sketch constraint emission (sketch-rewrite P4): the toolbar's
  // picks arrive as entity statement lines + point roles; the transform
  // hoists unbound producers and appends the constraint statement at the
  // sketch body's end — one edit, riding the generic apply-feature-edit
  // round trip (preflight + drift-honest ack).
  router.post('/sketch/add-constraint', async (req, res) => {
    const { sketchLine, filePath, kind, targets, valueExpr, axis, tangency } = req.body ?? {};
    if (typeof sketchLine !== 'number' || typeof kind !== 'string'
      || !Array.isArray(targets) || !constraintTargetCountValid(kind, targets.length)
      || (filePath !== undefined && typeof filePath !== 'string')
      || (valueExpr !== undefined && typeof valueExpr !== 'string')
      || (axis !== undefined && axis !== 'x' && axis !== 'y')
      || (tangency !== undefined && tangency !== 'max')) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    // A dimension typed as `name = value` (or a fresh name over the measured
    // value) declares that variable on the same commit — the same rail the
    // dialogs' expression fields ride.
    const nvResult = validateNewVariables(req.body?.newVariables);
    if ('error' in nvResult) {
      res.status(400).json({ error: nvResult.error });
      return;
    }
    // Target shapes are the emission transform's wire contract — one
    // sanitizer for both routes (add-constraint / insert-solved), recursive
    // for a mirror instance's `source`.
    const cleanTargets: SolvedEmissionTarget[] = [];
    for (const t of targets) {
      const cleaned = sanitizeEmissionTarget(t, { allowNew: false });
      if (cleaned === null) {
        res.status(400).json({ error: 'Invalid request body' });
        return;
      }
      cleanTargets.push(cleaned);
    }
    const targetFile = filePath ?? fluidCadServer.getCurrentFileName();
    if (!targetFile) {
      res.status(422).json({ success: false, reason: 'No rendered scene' });
      return;
    }
    const spec: ApplyFeatureEditSpec = {
      feature: 'sketch',
      filePath: targetFile,
      producers: [],
      parts: [],
      imports: [],
      sketchConstraint: {
        sketchLine,
        kind,
        targets: cleanTargets as any,
        ...(valueExpr !== undefined ? { valueExpr } : {}),
        ...(axis !== undefined ? { axis } : {}),
        ...(tangency !== undefined ? { tangency } : {}),
        ...(nvResult.newVariables !== undefined ? { newVariables: nvResult.newVariables } : {}),
      },
    };
    await dispatcher.dispatch(res, spec, { success: true });
  });

  // Sketch Split tool (2D): the kernel projects the click onto the picked
  // entity and cuts it (lib SketchEntitySplit); the statement transform then
  // rewrites the source as the pieces. The UI sends the entity's SOLVED
  // geometry (the statement's literals are guesses) plus, per constraint
  // that acts somewhere along the entity, where it touches it — resolved
  // here to the piece that place falls on.
  router.post('/sketch/split', async (req, res) => {
    const { sketchLine, filePath, line, entity, at, hints, settle } = req.body ?? {};
    const cleanEntity = sanitizeSplittableEntity(entity);
    const cleanAt = sanitizeSplitPoint(at);
    const cleanHints = sanitizeCutHints(hints);
    const cleanSettle = validateSketchPositionEdits(settle);
    if (typeof sketchLine !== 'number' || typeof line !== 'number'
      || (filePath !== undefined && typeof filePath !== 'string')
      || cleanEntity === null || cleanAt === null || cleanHints === null || cleanSettle === null) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const targetFile = filePath ?? fluidCadServer.getCurrentFileName();
    if (!targetFile) {
      res.status(422).json({ success: false, reason: 'No rendered scene' });
      return;
    }
    let split: ReturnType<typeof SketchEntitySplit.split>;
    try {
      split = SketchEntitySplit.split(cleanEntity, cleanAt);
    } catch (err) {
      if (err instanceof SplitRefusal) {
        res.status(422).json({ success: false, reason: err.message });
        return;
      }
      throw err;
    }
    const sketchSplit: SketchSplitSpec = {
      sketchLine,
      line,
      pieces: split.pieces,
      ...(cleanHints.length > 0 && split.pieces.length === 2
        ? { assignments: assignHints(split.pieces, cleanHints) }
        : {}),
      ...(cleanSettle.length > 0 ? { settle: cleanSettle } : {}),
    };

    // Preflight for the report (what was removed, the pieces' names); the
    // dispatcher preflights again for the drift guard.
    let report: Record<string, unknown> = {};
    if (targetFile === fluidCadServer.getCurrentFileName()) {
      const code = fluidCadServer.getCurrentCode();
      if (code !== null) {
        try {
          const dryRun = await SketchSplit.apply(code, sketchSplit);
          if (dryRun.error) {
            res.status(422).json({ success: false, reason: dryRun.error });
            return;
          }
          report = {
            ...(dryRun.removed !== undefined ? { removed: dryRun.removed } : {}),
            ...(dryRun.names !== undefined ? { names: dryRun.names } : {}),
            ...(dryRun.sketchLine !== undefined ? { sketchLine: dryRun.sketchLine } : {}),
          };
        } catch {
          // A preflight crash is not a verdict — the editor round-trip decides.
        }
      }
    }
    const spec: ApplyFeatureEditSpec = {
      feature: 'sketch',
      filePath: targetFile,
      producers: [],
      parts: [],
      imports: [],
      sketchSplit,
    };
    await dispatcher.dispatch(res, spec, { success: true, at: split.at, ...report });
  });

  // Sketch Trim tool (2D): the UI found the entity's nearest intersections
  // on either side of the click; the kernel cuts the entity there (lib
  // SketchEntitySplit.cut) and the statement transform deletes the piece
  // the click named, rewriting the source as what survives. Like the split,
  // the entity's SOLVED geometry travels with the request, plus where each
  // whole-entity constraint touches it — a constraint touching the removed
  // piece goes with it.
  router.post('/sketch/trim', async (req, res) => {
    const { sketchLine, filePath, line, entity, cuts, cutters, removed, hints, settle } = req.body ?? {};
    const cleanEntity = sanitizeSplittableEntity(entity);
    const cleanCuts = Array.isArray(cuts) ? cuts.map(sanitizeSplitPoint) : null;
    const cleanCutters = cleanCuts ? sanitizeCutters(cutters, cleanCuts.length) : null;
    const cleanHints = sanitizeCutHints(hints);
    const cleanSettle = validateSketchPositionEdits(settle);
    if (typeof sketchLine !== 'number' || typeof line !== 'number'
      || (filePath !== undefined && typeof filePath !== 'string')
      || cleanEntity === null || cleanCuts === null || cleanCuts.some(c => c === null) || cleanCuts.length > 2
      || cleanCutters === null
      || !Number.isInteger(removed) || removed < 0 || removed > cleanCuts.length
      || cleanHints === null || cleanSettle === null) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const targetFile = filePath ?? fluidCadServer.getCurrentFileName();
    if (!targetFile) {
      res.status(422).json({ success: false, reason: 'No rendered scene' });
      return;
    }
    let pieces: SplitPiece[];
    try {
      pieces = SketchEntitySplit.cut(cleanEntity, cleanCuts as SplitPoint[]);
    } catch (err) {
      if (err instanceof SplitRefusal) {
        res.status(422).json({ success: false, reason: err.message });
        return;
      }
      throw err;
    }
    if (removed >= pieces.length) {
      res.status(422).json({ success: false, reason: 'the clicked piece is not one the cut yields' });
      return;
    }
    const sketchTrim: SketchTrimSpec = {
      sketchLine,
      line,
      pieces,
      removed,
      ...(cleanCutters.length > 0 ? { cutters: cleanCutters } : {}),
      ...(cleanHints.length > 0 ? { assignments: assignHints(pieces, cleanHints) } : {}),
      ...(cleanSettle.length > 0 ? { settle: cleanSettle } : {}),
    };

    // Preflight for the report (what was removed, the survivors' names); the
    // dispatcher preflights again for the drift guard.
    let report: Record<string, unknown> = {};
    if (targetFile === fluidCadServer.getCurrentFileName()) {
      const code = fluidCadServer.getCurrentCode();
      if (code !== null) {
        try {
          const dryRun = await SketchTrim.apply(code, sketchTrim);
          if (dryRun.error) {
            res.status(422).json({ success: false, reason: dryRun.error });
            return;
          }
          report = {
            ...(dryRun.removed !== undefined ? { removed: dryRun.removed } : {}),
            ...(dryRun.names !== undefined ? { names: dryRun.names } : {}),
            ...(dryRun.deleted !== undefined ? { deleted: dryRun.deleted } : {}),
            ...(dryRun.sketchLine !== undefined ? { sketchLine: dryRun.sketchLine } : {}),
          };
        } catch {
          // A preflight crash is not a verdict — the editor round-trip decides.
        }
      }
    }
    const spec: ApplyFeatureEditSpec = {
      feature: 'sketch',
      filePath: targetFile,
      producers: [],
      parts: [],
      imports: [],
      sketchTrim,
    };
    await dispatcher.dispatch(res, spec, { success: true, ...report });
  });

  // Sketcher Delete key: remove the picked entity statements (by line) in
  // one edit, with the constraints naming them and the statements that
  // consumed them. Like the cut tools, the sketch's solved positions travel
  // with the request so a borrowed point is substituted at rest.
  router.post('/sketch/delete', async (req, res) => {
    const { sketchLine, filePath, lines, settle } = req.body ?? {};
    const cleanSettle = validateSketchPositionEdits(settle);
    if (typeof sketchLine !== 'number'
      || (filePath !== undefined && typeof filePath !== 'string')
      || !Array.isArray(lines) || lines.length === 0
      || lines.some(line => !Number.isInteger(line) || line < 1)
      || cleanSettle === null) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const targetFile = filePath ?? fluidCadServer.getCurrentFileName();
    if (!targetFile) {
      res.status(422).json({ success: false, reason: 'No rendered scene' });
      return;
    }
    const sketchDelete: SketchDeleteSpec = {
      sketchLine,
      lines: [...new Set(lines as number[])],
      ...(cleanSettle.length > 0 ? { settle: cleanSettle } : {}),
    };

    // Preflight for the report (what else went); the dispatcher preflights
    // again for the drift guard.
    let report: Record<string, unknown> = {};
    if (targetFile === fluidCadServer.getCurrentFileName()) {
      const code = fluidCadServer.getCurrentCode();
      if (code !== null) {
        try {
          const dryRun = await SketchEntityDelete.apply(code, sketchDelete);
          if (dryRun.error) {
            res.status(422).json({ success: false, reason: dryRun.error });
            return;
          }
          report = {
            ...(dryRun.removed !== undefined ? { removed: dryRun.removed } : {}),
            ...(dryRun.dependents !== undefined ? { dependents: dryRun.dependents } : {}),
          };
        } catch {
          // A preflight crash is not a verdict — the editor round-trip decides.
        }
      }
    }
    const spec: ApplyFeatureEditSpec = {
      feature: 'sketch',
      filePath: targetFile,
      producers: [],
      parts: [],
      imports: [],
      sketchDelete,
    };
    await dispatcher.dispatch(res, spec, { success: true, ...report });
  });

  // Distance-dimension tangency rewrite (timeline "Use min/max tangent"):
  // strip/append the statement's chained `.max()` in one edit.
  router.post('/sketch/set-distance-tangency', async (req, res) => {
    const { filePath, line, tangency } = req.body ?? {};
    if (typeof line !== 'number'
      || (tangency !== 'min' && tangency !== 'max')
      || (filePath !== undefined && typeof filePath !== 'string')) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const targetFile = filePath ?? fluidCadServer.getCurrentFileName();
    if (!targetFile) {
      res.status(422).json({ success: false, reason: 'No rendered scene' });
      return;
    }
    const spec: ApplyFeatureEditSpec = {
      feature: 'sketch',
      filePath: targetFile,
      producers: [],
      parts: [],
      imports: [],
      distanceTangency: { line, tangency },
    };
    await dispatcher.dispatch(res, spec, { success: true });
  });

  // Solved-sketch drawing-tool emission (sketch-rewrite P5): geometry +
  // constraint statements in one edit, geometry before the body's first
  // constraint statement (locked plan §0.2), constraints appended at the
  // body end. Preflights against the server's code copy so the response can
  // carry each geometry statement's final line — the polyline chain
  // references its previous segment by line without waiting for a render.
  router.post('/sketch/insert-solved', async (req, res) => {
    const { sketchLine, filePath, geometry, constraints, newVariables, removals } = req.body ?? {};
    // A removals-only body is a legal edit: the constraint bar deletes the
    // coincident(s) behind a vertex pick through this rail so a junction's
    // several statements go in one edit.
    const removalCount = Array.isArray(removals) ? removals.length : 0;
    if (typeof sketchLine !== 'number'
      || !Array.isArray(geometry) || !Array.isArray(constraints)
      || geometry.length + constraints.length + removalCount === 0
      || (filePath !== undefined && typeof filePath !== 'string')
      || (newVariables !== undefined && !Array.isArray(newVariables))
      || (removals !== undefined && !Array.isArray(removals))) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    // Statement removals riding the emission (the constraint-native fillet
    // deletes each corner's coincident as it emits the replacing arc).
    const cleanRemovals: { line: number }[] = [];
    for (const r of removals ?? []) {
      if (typeof r !== 'object' || r === null || !Number.isInteger(r.line) || r.line < 1) {
        res.status(400).json({ error: 'Invalid request body' });
        return;
      }
      cleanRemovals.push({ line: r.line });
    }
    const cleanGeometry: SolvedGeometryEmission[] = [];
    for (const g of geometry) {
      if (typeof g !== 'object' || g === null || !SOLVED_GEOMETRY_CALLEES.has(g.kind)
        || typeof g.text !== 'string' || (g.guide !== undefined && typeof g.guide !== 'boolean')) {
        res.status(400).json({ error: 'Invalid request body' });
        return;
      }
      cleanGeometry.push({
        kind: g.kind, text: g.text,
        ...(g.guide !== undefined ? { guide: g.guide } : {}),
      });
    }
    const cleanConstraints: SolvedConstraintEmission[] = [];
    for (const c of constraints) {
      if (typeof c !== 'object' || c === null || !SOLVED_CONSTRAINT_KINDS.has(c.kind)
        || !Array.isArray(c.targets) || !constraintTargetCountValid(c.kind, c.targets.length)
        || (c.valueExpr !== undefined && typeof c.valueExpr !== 'string')
        || (c.axis !== undefined && c.axis !== 'x' && c.axis !== 'y')) {
        res.status(400).json({ error: 'Invalid request body' });
        return;
      }
      const cleanTargets: SolvedEmissionTarget[] = [];
      for (const t of c.targets) {
        const cleaned = sanitizeEmissionTarget(t, { allowNew: true });
        if (cleaned === null) {
          res.status(400).json({ error: 'Invalid request body' });
          return;
        }
        cleanTargets.push(cleaned);
      }
      cleanConstraints.push({
        kind: c.kind, targets: cleanTargets,
        ...(c.valueExpr !== undefined ? { valueExpr: c.valueExpr } : {}),
        ...(c.axis !== undefined ? { axis: c.axis } : {}),
      });
    }
    const cleanVariables: { name: string; initializer: string }[] = [];
    for (const v of newVariables ?? []) {
      if (typeof v !== 'object' || v === null
        || typeof v.name !== 'string' || typeof v.initializer !== 'string') {
        res.status(400).json({ error: 'Invalid request body' });
        return;
      }
      cleanVariables.push({ name: v.name, initializer: v.initializer });
    }
    const targetFile = filePath ?? fluidCadServer.getCurrentFileName();
    if (!targetFile) {
      res.status(422).json({ success: false, reason: 'No rendered scene' });
      return;
    }
    const emission = {
      sketchLine,
      geometry: cleanGeometry,
      constraints: cleanConstraints,
      ...(cleanVariables.length > 0 ? { newVariables: cleanVariables } : {}),
      ...(cleanRemovals.length > 0 ? { removals: cleanRemovals } : {}),
    };

    // Preflight for the line info (and a fast honest 422); the dispatcher
    // preflights again for the drift guard, which is cheap.
    let geometryLines: number[] | undefined;
    let names: (string | null)[] | undefined;
    let newSketchLine: number | undefined;
    if (targetFile === fluidCadServer.getCurrentFileName()) {
      const code = fluidCadServer.getCurrentCode();
      if (code !== null) {
        try {
          const dryRun = await applySolvedEmission(code, emission);
          if (dryRun.error) {
            res.status(422).json({ success: false, reason: dryRun.error });
            return;
          }
          geometryLines = dryRun.geometryLines;
          names = dryRun.names;
          newSketchLine = dryRun.sketchLine;
        } catch {
          // A preflight crash is not a verdict — the editor round-trip decides.
        }
      }
    }

    const spec: ApplyFeatureEditSpec = {
      feature: 'sketch',
      filePath: targetFile,
      producers: [],
      parts: [],
      imports: [],
      sketchEmission: emission,
    };
    await dispatcher.dispatch(res, spec, {
      success: true,
      ...(geometryLines !== undefined ? { geometryLines } : {}),
      ...(names !== undefined ? { names } : {}),
      ...(newSketchLine !== undefined ? { sketchLine: newSketchLine } : {}),
    });
  });
}
