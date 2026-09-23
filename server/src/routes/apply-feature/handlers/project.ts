// POST /apply-feature, the project create branch.

import type { Request, Response } from 'express';
import {
  extractNumericParams,
  makeProducerNamer,
  PROJECTION_OPS,
  resolveParamValues,
  type ApplyFeatureEditSpec,
  type ProjectionOp,
} from '../../../apply-feature-edit/index.ts';
import { normalizePath } from '../../../normalize-path.ts';
import { validateSketchLoc } from '../locations.ts';
import { validateChains, validatePicks } from '../picks.ts';
import { allocateProducerVars, makeProducerMerger } from '../synthesis.ts';
import { MAX_PROJECT_SKETCHES, projectSketchRefusal, validateProjectSketches } from '../validate/project.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// Project is the hybrid branch: the picks are ordinary 3D edges and faces
// (synthesized like a fillet's), but the statement lands inside the body
// of the sketch named by `sketch` — `project()` reads the sketch it is
// called from. The transform binds the producers where they already live.
export async function handleProject(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, foreignPicks, dispatchCrossFileCreates, foreignBody, preview, selectorOverride } = ctx;
  // The sources: 3D picks (synthesized like a fillet's) and/or previous
  // sketches referenced whole (`project(s1)`, bound like an extrude's
  // profile). Either list may be empty, not both.
  const sketches = validateProjectSketches(req.body?.sketches);
  if (!sketches) {
    res.status(400).json({ error: `sketches must be an array of at most ${MAX_PROJECT_SKETCHES} {filePath, line, column} sketch call sites` });
    return;
  }
  const hasEntities = Array.isArray(req.body?.entities) && req.body.entities.length > 0;
  const picks = hasEntities ? validatePicks(req.body?.entities) : [];
  if (!picks) {
    res.status(400).json({ error: 'entities must be an array of {shapeId, sub:{type, index}} picks' });
    return;
  }
  if (picks.length === 0 && sketches.length === 0) {
    res.status(400).json({ error: 'pick at least one source: entities (edges/faces) or sketches' });
    return;
  }
  const chains = validateChains(req.body?.chains);
  if (!chains) {
    res.status(400).json({ error: 'chains must be {seed, members} pick groups' });
    return;
  }
  const sketchLoc = validateSketchLoc(req.body?.sketch);
  if (!sketchLoc) {
    res.status(400).json({ error: 'sketch must be {filePath, line, column} of the sketch receiving the projection' });
    return;
  }
  // The callee: `project()` flattens along the sketch normal (the
  // default), `intersect()` sections the sources with the sketch plane.
  // Everything else — picks, synthesis, landing spot — is shared.
  const op: ProjectionOp = req.body?.op ?? 'project';
  if (!PROJECTION_OPS.includes(op)) {
    res.status(400).json({ error: 'op must be "project" or "intersect"' });
    return;
  }
  if (selectorOverride !== undefined
    && (typeof selectorOverride !== 'string' || selectorOverride.trim().length === 0 || selectorOverride.length > 500)) {
    res.status(400).json({ error: 'selectorOverride must be a non-empty string (max 500 chars)' });
    return;
  }
  try {
    // Consumer-side cross-part sources: a pick owned by a part OTHER than
    // the one the sketch lives in is published from its donor
    // (find-or-create an expose()) and referenced as
    // `<donor>.features.<name>` — the sketch-on-face rail, one reference
    // per pick. The consumer is the sketch's own part, read off the
    // scene; without one (a top-level sketch, an assembly scene, a
    // kernel predating the lookup) every pick is local as before.
    const consumer = fluidCadServer.resolveStatementPart?.(sketchLoc) ?? null;
    const resolution = consumer && picks.length > 0
      ? await foreignPicks.resolve(picks, chains, consumer)
      : { ok: true as const, local: picks, chains, refs: [], expressions: [], picks: [], crossFileCreates: [] };
    if (resolution.ok === false) {
      res.status(resolution.status).json({
        success: false, reason: resolution.reason, ...(resolution.pick ? { pick: resolution.pick } : {}),
      });
      return;
    }
    for (const loc of sketches) {
      const refusal = projectSketchRefusal(
        loc, sketchLoc, consumer, fluidCadServer.resolveStatementPart?.bind(fluidCadServer),
      );
      if (refusal) {
        res.status(422).json({ success: false, reason: refusal });
        return;
      }
    }

    let localSpec: ApplyFeatureEditSpec | null = null;
    let localArgs = '';
    let localAlternatives: string[] = [];
    if (resolution.local.length > 0) {
      const code = fluidCadServer.getCurrentCode();
      const options = code
        ? {
          namer: await makeProducerNamer(code),
          params: resolveParamValues(
            await extractNumericParams(code),
            fluidCadServer.getParamDefinitions(),
          ),
        }
        : undefined;
      const synthesis = fluidCadServer.synthesizeApplyFeature(
        resolution.local, 'project', undefined, resolution.chains, options,
      );
      if (!synthesis) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return;
      }
      if (!synthesis.ok) {
        res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
        return;
      }
      // The sources and the sketch must share a file: the statement binds
      // their variables from inside the sketch body.
      if (normalizePath(synthesis.spec.filePath) !== normalizePath(sketchLoc.filePath)) {
        res.status(422).json({
          success: false,
          reason: 'the picked geometry lives in a different file than the sketch',
        });
        return;
      }
      localSpec = synthesis.spec;
      localArgs = synthesis.args;
      localAlternatives = synthesis.alternatives ?? [];
    }
    // The sketch sources bind as sketch producers (an extrude profile's
    // kind: the transform verifies the sketch() call and reuses or
    // introduces its variable) and render as bare variables after the
    // synthesized selectors. Named here with the transform's own namer
    // over the full producer list, so the preview shows the exact names
    // the rewrite allocates.
    const { producers, merge: mergeProducer } = makeProducerMerger();
    const parts: ApplyFeatureEditSpec['parts'] = [];
    if (localSpec) {
      const remap = localSpec.producers.map(mergeProducer);
      for (const part of localSpec.parts) {
        parts.push({
          ...part,
          producer: part.producer === null ? null : remap[part.producer],
          refs: part.refs ? part.refs.map(i => remap[i]) : part.refs,
        });
      }
    }
    const sketchProducers = sketches.map(loc => mergeProducer({
      line: loc.line, column: loc.column, featureType: 'sketch', nameHint: 's', bind: true,
    }));
    for (const producer of sketchProducers) {
      parts.push({ producer, accessor: '', indices: null, filterArgs: null });
    }
    const producerVars = sketches.length > 0
      ? await allocateProducerVars(producers, fluidCadServer.getCurrentCode())
      : [];
    const sketchArgs = sketchProducers.map((producer, i) => producerVars[producer] ?? `s${i === 0 ? '' : i + 1}`);
    // The references append after the sketch's own selectors — in the
    // synthesized list and in each verified alternative alike.
    const withReferences = (own: string): string =>
      [own, ...sketchArgs, ...resolution.expressions].filter(arg => arg !== '').join(', ');
    const args = withReferences(localArgs);
    // Composed here rather than taken from `synthesis.preview`: the args
    // ARE the statement, and composing keeps the preview identical to what
    // the transform writes even against a workspace kernel that predates
    // the project feature kind (it would render the valued form).
    const statementPreview = `${op}(${args})`;
    if (preview === true) {
      res.json({
        success: true,
        preview: statementPreview,
        args,
        alternatives: localAlternatives.map(withReferences),
        ...foreignBody(resolution.picks),
      });
      return;
    }
    // Publishing another part's geometry is a visible edit to THAT part,
    // so the apply carries the user's explicit go-ahead; a refusal echoes
    // the picks so the dialog can raise its notice even when the click
    // outran the preview.
    if (resolution.picks.length > 0 && req.body?.confirmForeign !== true) {
      res.status(422).json({
        success: false,
        reason: 'the picked geometry belongs to another part — confirm the cross-part references before applying',
        ...foreignBody(resolution.picks),
      });
      return;
    }
    if (!(await dispatchCrossFileCreates(res, resolution.crossFileCreates))) {
      return;
    }
    let spec: ApplyFeatureEditSpec = {
      filePath: sketchLoc.filePath,
      producers,
      parts,
      imports: localSpec?.imports ?? [],
      feature: 'project',
      value: undefined,
      project: {
        sketch: { line: sketchLoc.line, column: sketchLoc.column },
        ...(op !== 'project' ? { op } : {}),
        ...(resolution.refs.length > 0 ? { foreign: resolution.refs } : {}),
      },
    };
    if (typeof selectorOverride === 'string' && selectorOverride.trim() !== args) {
      spec = { ...spec, rawArgs: selectorOverride.trim() };
    }
    await dispatcher.dispatch(res, spec, { success: true, preview: statementPreview });
  } catch (err: any) {
    res.status(500).json({ success: false, reason: err?.message ?? String(err) });
  }
}
