// POST /apply-feature, selector features: fillet, chamfer, shell, offset and sketch-on-face from 3D picks.

import type { Request, Response } from 'express';
import {
  extractNumericParams,
  makeProducerNamer,
  renderChamferValueArgs,
  renderShellJoinChain,
  resolveParamValues,
  validValueExpr,
  type ApplyFeatureEditSpec,
  type ChamferEditOptions,
  type ShellJoinKind,
} from '../../../apply-feature-edit/index.ts';
import { validateChains, validatePicks } from '../picks.ts';
import { validateChamferOptions, validateShellJoinType } from '../validate/options.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

export async function handleSelectorFeature(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, foreignPicks, dispatchCrossFileCreates, foreignBody, feature, value, preview, selectorOverride, newVariables, activePartLoc } = ctx;
  const picks = validatePicks(req.body?.entities);
  if (!picks) {
    res.status(400).json({ error: 'entities must be a non-empty array of {shapeId, sub:{type, index}} picks' });
    return;
  }
  const chains = validateChains(req.body?.chains);
  if (!chains) {
    res.status(400).json({ error: 'chains must be {seed, members} pick groups' });
    return;
  }

  // Consumer-side cross-part sketch: the picked face belongs to a part
  // OTHER than the timeline's active part. Instead of inserting into the
  // donor (the producers' scope — surprising while another part is
  // active), publish the face from the donor (find-or-create an expose())
  // and sketch on the exposure reference inside the ACTIVE part's body.
  if (feature === 'sketch' && activePartLoc && picks.length === 1
    && chains.length === 0 && picks[0].sub.type === 'face') {
    const resolution = await foreignPicks.resolve(picks, [], activePartLoc);
    if (resolution.ok === false) {
      res.status(resolution.status).json({ success: false, reason: resolution.reason });
      return;
    }
    if (resolution.refs.length > 0) {
      try {
        const statementPreview = `sketch(${resolution.expressions[0]}, () => { ... })`;
        if (preview === true) {
          res.json({ success: true, preview: statementPreview, args: '', ...foreignBody(resolution.picks) });
          return;
        }
        // A cross-file exposure can't ride the consumer transform — create
        // it in the donor file first, then land the reference. A same-file
        // create rides the spec and stays atomic in one transform.
        if (!(await dispatchCrossFileCreates(res, resolution.crossFileCreates))) {
          return;
        }
        const spec: ApplyFeatureEditSpec = {
          feature: 'sketch',
          filePath: activePartLoc.filePath,
          producers: [],
          parts: [],
          imports: [],
          activePart: { line: activePartLoc.line, column: activePartLoc.column },
          sketchForeign: resolution.refs[0],
        };
        await dispatcher.dispatch(res, spec, { success: true, preview: statementPreview });
      } catch (err: any) {
        res.status(500).json({ success: false, reason: err?.message ?? String(err) });
      }
      return;
    }
  }

  if (feature !== 'fillet' && feature !== 'chamfer' && feature !== 'shell' && feature !== 'sketch'
    && feature !== 'offset') {
    res.status(400).json({ error: 'feature must be "fillet", "chamfer", "shell", "sketch", "offset", "extrude", "rib", "sweep", "wrap", "loft", "revolve", "plane", "project", "repeat", "copy" or "boolean"' });
    return;
  }
  // Per-feature numeric parameter: fillet/chamfer need a positive radius or
  // distance (chamfer optionally a second distance or angle); shell needs a
  // nonzero thickness (negative is the idiom — shell(-2, …) hollows inward)
  // plus its join type; the face-target offset needs a nonzero distance
  // (negative offsets inward); sketch has no numeric parameter at all.
  let shellJoin: ShellJoinKind = 'arc';
  let chamferOptions: ChamferEditOptions | undefined;
  if (feature === 'shell') {
    if (!validValueExpr(value, { nonzero: true })) {
      res.status(400).json({ error: 'value must be a nonzero number or expression (negative hollows inward)' });
      return;
    }
    const join = validateShellJoinType(req.body?.joinType);
    if ('error' in join) {
      res.status(400).json({ error: join.error });
      return;
    }
    shellJoin = join.joinType;
  } else if (feature === 'offset') {
    if (!validValueExpr(value, { nonzero: true })) {
      res.status(400).json({ error: 'value must be a nonzero number or expression (negative offsets inward)' });
      return;
    }
  } else if (feature !== 'sketch') {
    if (!validValueExpr(value, { positive: true })) {
      res.status(400).json({ error: 'value must be a positive number or expression' });
      return;
    }
    if (feature === 'chamfer') {
      const chamfer = validateChamferOptions(req.body);
      if ('error' in chamfer) {
        res.status(400).json({ error: chamfer.error });
        return;
      }
      chamferOptions = chamfer.options.distance2 !== null ? chamfer.options : undefined;
    }
  }
  if (selectorOverride !== undefined
    && (typeof selectorOverride !== 'string' || selectorOverride.trim().length === 0 || selectorOverride.length > 500)) {
    res.status(400).json({ error: 'selectorOverride must be a non-empty string (max 500 chars)' });
    return;
  }

  try {
    // Source-derived context from the live buffer: the namer keeps
    // previewed variable names truthful to the transform (reused const
    // names, collisions suffixed past file identifiers); params let
    // synthesized dimension constants render as the user's own variables.
    // Without a buffer, synthesis falls back to hints and bare numbers.
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
      picks, feature, feature === 'sketch' ? undefined : value, chains, options,
    );
    if (!synthesis) {
      res.status(404).json({ success: false, reason: 'No rendered scene' });
      return;
    }
    if (!synthesis.ok) {
      res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
      return;
    }
    // Synthesis renders the bare statement; the shell join chain and the
    // chamfer second value ride the spec, so the preview must fold them in
    // to stay truthful.
    const joinChain = feature === 'shell' ? renderShellJoinChain(shellJoin) : '';
    const statementPreview = chamferOptions
      ? `chamfer(${renderChamferValueArgs(value, chamferOptions)}, ${synthesis.args})`
      : synthesis.preview + joinChain;
    if (preview === true) {
      res.json({
        success: true,
        preview: statementPreview,
        args: synthesis.args,
        alternatives: synthesis.alternatives,
      });
      return;
    }
    let spec: ApplyFeatureEditSpec = typeof selectorOverride === 'string' && selectorOverride.trim() !== synthesis.args
      ? { ...synthesis.spec, rawArgs: selectorOverride.trim() }
      : synthesis.spec;
    if (feature === 'shell') {
      spec = { ...spec, shell: { joinType: shellJoin } };
    }
    if (chamferOptions) {
      spec = { ...spec, chamfer: chamferOptions };
    }
    if (newVariables) {
      spec = { ...spec, newVariables };
    }
    await dispatcher.dispatch(res, spec, { success: true, preview: statementPreview });
  } catch (err: any) {
    res.status(500).json({ success: false, reason: err?.message ?? String(err) });
  }
}
