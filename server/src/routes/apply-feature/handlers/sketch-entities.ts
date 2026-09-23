// POST /apply-feature, sketch-edge picks: fillet, offset, text, in-sketch copy and mirror inside a sketch body.

import type { Request, Response } from 'express';
import {
  extractNumericParams,
  makeProducerNamer,
  renderCopyCenterExpr,
  renderCopyStatement,
  renderMirrorAxisExpr,
  renderMirrorStatement,
  renderOffsetStatement,
  renderRepeatAxisExpr,
  renderTextStatement,
  resolveParamValues,
  validValueExpr,
  type ApplyFeatureEditSpec,
  type CopyEditOptions,
  type MirrorAxisSpec,
  type MirrorEditOptions,
  type OffsetEditOptions,
  type TextStatementOptions,
} from '../../../apply-feature-edit/index.ts';
import { validateSketchPicks } from '../picks.ts';
import { allocateProducerVars } from '../synthesis.ts';
import { validateOffsetOptions, validateTextOptions } from '../validate/options.ts';
import { validateSketchCopy, validateSketchMirror } from '../validate/sketch-transforms.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// Sketch-edge picks (2D branch): 1 shapeId = 1 sketch edge, no sub refs.
// Synthesis resolves them through the sketch edge index and the emitted
// statement lands inside the sketch body via the same edit-spec transform.
export async function handleSketchEntities(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, feature, value, preview, selectorOverride, newVariables } = ctx;
  const sketchPicks = validateSketchPicks(req.body.sketchEntities);
  if (!sketchPicks) {
    res.status(400).json({ error: 'sketchEntities must be a non-empty array of {shapeId} picks' });
    return;
  }
  if (feature !== 'fillet' && feature !== 'offset'
    && feature !== 'text' && feature !== 'copy' && feature !== 'mirror') {
    res.status(400).json({ error: 'feature must be "fillet", "offset", "text", "copy" or "mirror" for sketch-edge selections' });
    return;
  }
  // The 2D copy: whole-geometry targets rendered as bare variables plus
  // the statement's option payload; an edge-picked direction rides its
  // own pick list. Self-contained — none of the value/toggle ladder below
  // applies to it.
  if (feature === 'copy') {
    const request = validateSketchCopy(req.body);
    if ('error' in request) {
      res.status(400).json({ error: request.error });
      return;
    }
    const edgeDirections = request.kind === 'linear'
      ? request.directions!.filter(d => d.axis.kind === 'edge').length
      : 0;
    let axisPicks: { shapeId: string }[] = [];
    if (req.body?.sketchAxisEntities !== undefined) {
      const picks = validateSketchPicks(req.body.sketchAxisEntities);
      if (!picks) {
        res.status(400).json({ error: 'sketchAxisEntities must be a non-empty array of {shapeId} picks' });
        return;
      }
      axisPicks = picks;
    }
    if (axisPicks.length !== edgeDirections) {
      res.status(400).json({ error: 'sketchAxisEntities must carry exactly one pick per edge-picked direction' });
      return;
    }
    try {
      const code = fluidCadServer.getCurrentCode();
      const options = {
        ...(code
          ? {
            namer: await makeProducerNamer(code),
            params: resolveParamValues(
              await extractNumericParams(code),
              fluidCadServer.getParamDefinitions(),
            ),
          }
          : {}),
        axisRefs: axisPicks,
      };
      const synthesis = fluidCadServer.synthesizeSketchApplyFeature(sketchPicks, 'copy', undefined, options);
      if (!synthesis) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return;
      }
      if (!synthesis.ok) {
        res.status(422).json({ success: false, reason: synthesis.reason });
        return;
      }
      // A workspace kernel predating the 'copy' kind falls through to the
      // accessor synthesis, which reports no operand slots.
      const slots = synthesis.copySlots;
      if (!slots) {
        res.status(422).json({
          success: false,
          reason: "the workspace's FluidCAD version does not support the 2D copy dialog — update its fluidcad dependency",
        });
        return;
      }
      let axisPartIndex = 0;
      const copyOptions: CopyEditOptions = {
        kind: request.kind,
        directions: request.kind === 'linear'
          ? request.directions!.map(d => ({
            axis: d.axis.kind === 'edge'
              ? { kind: 'selector' as const, part: slots.axisParts[axisPartIndex++] }
              : { kind: 'local' as const, axis: d.axis.axis },
            count: d.count,
            value: d.value,
          }))
          : undefined,
        spacingMode: request.spacingMode,
        centered: request.centered === true ? true : undefined,
        center: request.center,
        count: request.count,
        sweep: request.sweep,
        skip: request.skip,
        targets: slots.targets.map((producer: number) => ({ producer })),
      };
      const imports = new Set<string>(synthesis.spec.imports);
      for (const d of copyOptions.directions ?? []) {
        if (d.axis.kind === 'local') {
          imports.add(`${d.axis.axis}Axis`);
        }
      }
      if (copyOptions.directions?.some(d => d.axis.kind === 'selector')) {
        imports.add('axis');
      }
      const spec: ApplyFeatureEditSpec = {
        ...synthesis.spec,
        copy: copyOptions,
        imports: [...imports],
        newVariables,
      };
      // Truthful preview: the same allocation walk the transform runs.
      const producerVars = await allocateProducerVars(spec.producers, code);
      const varFor = (i: number): string | null => producerVars[i];
      const inputExprs = request.kind === 'linear'
        ? copyOptions.directions!.map(d => renderRepeatAxisExpr(d.axis, spec.parts, varFor))
        : [renderCopyCenterExpr(request.center!)];
      const statement = renderCopyStatement(
        copyOptions, inputExprs,
        copyOptions.targets.map(t => producerVars[t.producer] ?? spec.producers[t.producer].nameHint ?? 'g'),
      );
      if (preview === true) {
        res.json({ success: true, preview: statement });
        return;
      }
      await dispatcher.dispatch(res, spec, { success: true, preview: statement });
    } catch (err: any) {
      res.status(500).json({ success: false, reason: err?.message ?? String(err) });
    }
    return;
  }
  // The 2D mirror: the copy's sibling — whole-geometry targets as bare
  // variables plus the line to reflect across, a sketch-plane datum or
  // a picked line riding its own single pick. Self-contained too.
  if (feature === 'mirror') {
    const request = validateSketchMirror(req.body);
    if ('error' in request) {
      res.status(400).json({ error: request.error });
      return;
    }
    let axisPicks: { shapeId: string }[] = [];
    if (req.body?.sketchAxisEntities !== undefined) {
      const picks = validateSketchPicks(req.body.sketchAxisEntities);
      if (!picks) {
        res.status(400).json({ error: 'sketchAxisEntities must be a non-empty array of {shapeId} picks' });
        return;
      }
      axisPicks = picks;
    }
    if (axisPicks.length !== (request.axis.kind === 'edge' ? 1 : 0)) {
      res.status(400).json({ error: 'sketchAxisEntities must carry exactly one pick for an edge-picked mirror line' });
      return;
    }
    try {
      const code = fluidCadServer.getCurrentCode();
      const options = {
        ...(code
          ? {
            namer: await makeProducerNamer(code),
            params: resolveParamValues(
              await extractNumericParams(code),
              fluidCadServer.getParamDefinitions(),
            ),
          }
          : {}),
        axisRefs: axisPicks,
      };
      const synthesis = fluidCadServer.synthesizeSketchApplyFeature(sketchPicks, 'mirror', undefined, options);
      if (!synthesis) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return;
      }
      if (!synthesis.ok) {
        res.status(422).json({ success: false, reason: synthesis.reason });
        return;
      }
      // A workspace kernel predating the 'mirror' kind falls through to
      // the accessor synthesis, which reports no operand slots.
      const slots = synthesis.copySlots;
      if (!slots) {
        res.status(422).json({
          success: false,
          reason: "the workspace's FluidCAD version does not support the 2D mirror dialog — update its fluidcad dependency",
        });
        return;
      }
      const axis: MirrorAxisSpec = request.axis.kind === 'edge'
        ? { kind: 'selector', part: slots.axisParts[0] }
        : { kind: 'local', axis: request.axis.axis };
      const mirrorOptions: MirrorEditOptions = {
        axis,
        op: 'add',
        targets: slots.targets.map((producer: number) => ({ producer })),
      };
      const imports = new Set<string>(synthesis.spec.imports);
      if (axis.kind === 'local') {
        imports.add(`${axis.axis}Axis`);
      }
      const spec: ApplyFeatureEditSpec = {
        ...synthesis.spec,
        mirror: mirrorOptions,
        imports: [...imports],
      };
      // Truthful preview: the same allocation walk the transform runs.
      const producerVars = await allocateProducerVars(spec.producers, code);
      const varFor = (i: number): string | null => producerVars[i];
      const statement = renderMirrorStatement(
        mirrorOptions,
        renderMirrorAxisExpr(axis, spec.parts, varFor),
        mirrorOptions.targets.map(t => producerVars[t.producer] ?? spec.producers[t.producer].nameHint ?? 'g'),
      );
      if (preview === true) {
        res.json({ success: true, preview: statement });
        return;
      }
      await dispatcher.dispatch(res, spec, { success: true, preview: statement });
    } catch (err: any) {
      res.status(500).json({ success: false, reason: err?.message ?? String(err) });
    }
    return;
  }
  if (req.body?.copy2d !== undefined || req.body?.mirror2d !== undefined
    || req.body?.sketchAxisEntities !== undefined) {
    res.status(400).json({ error: 'copy2d, mirror2d and sketchAxisEntities only apply to copy and mirror' });
    return;
  }
  // Text carries no numeric parameter (it rides its full option payload
  // instead).
  const sketchValueless = feature === 'text';
  // Fillet needs a positive radius; offset allows a negative
  // distance (the inward idiom) but not zero.
  if (feature === 'fillet' && !validValueExpr(value, { positive: true })) {
    res.status(400).json({ error: 'value must be a positive number or expression' });
    return;
  }
  // Offset's distance allows negative (the inward idiom) but not zero.
  if (feature === 'offset' && !validValueExpr(value, { nonzero: true })) {
    res.status(400).json({ error: 'value must be a nonzero number or expression' });
    return;
  }
  // Text-on-path: the dialog's full option payload rides the body; the
  // synthesized bare variable becomes the statement's path argument.
  let textOptions: TextStatementOptions | undefined;
  if (feature === 'text') {
    const parsed = validateTextOptions(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    textOptions = parsed.options;
  }
  // Offset's dialog toggle: `.close()`.
  let offsetOptions: OffsetEditOptions | undefined;
  if (feature === 'offset') {
    const parsed = validateOffsetOptions(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    offsetOptions = parsed.options;
  } else if (req.body?.removeOriginal !== undefined || req.body?.close !== undefined) {
    res.status(400).json({ error: 'close only applies to offset' });
    return;
  }
  if (selectorOverride !== undefined
    && (typeof selectorOverride !== 'string' || selectorOverride.trim().length === 0 || selectorOverride.length > 500)) {
    res.status(400).json({ error: 'selectorOverride must be a non-empty string (max 500 chars)' });
    return;
  }
  try {
    const code = fluidCadServer.getCurrentCode();
    const options = code
      ? {
        namer: await makeProducerNamer(code),
        params: resolveParamValues(
          await extractNumericParams(code),
          fluidCadServer.getParamDefinitions(),
        ),
        offset: offsetOptions,
      }
      : { offset: offsetOptions };
    const synthesis = fluidCadServer.synthesizeSketchApplyFeature(
      sketchPicks, feature, sketchValueless ? undefined : value, options,
    );
    if (!synthesis) {
      res.status(404).json({ success: false, reason: 'No rendered scene' });
      return;
    }
    if (!synthesis.ok) {
      res.status(422).json({ success: false, reason: synthesis.reason });
      return;
    }
    // A text path's argument is ONE whole geometry, so only a
    // bare variable works.
    if (feature === 'text' && !/^[A-Za-z_$][\w$]*$/.test(synthesis.args)) {
      res.status(422).json({
        success: false,
        reason: "the workspace's FluidCAD version does not support picking a text path — update its fluidcad dependency",
      });
      return;
    }
    // The toggles are statement shape, not selection knowledge: re-attach
    // them here so a workspace kernel predating them still writes (and
    // previews) the form the dialog asked for.
    const statement = offsetOptions
      ? renderOffsetStatement(value, synthesis.args, offsetOptions)
      : feature === 'text'
        ? renderTextStatement(textOptions!, synthesis.args)
        : synthesis.preview;
    if (preview === true) {
      res.json({
        success: true,
        preview: statement,
        args: synthesis.args,
        alternatives: synthesis.alternatives,
      });
      return;
    }
    let spec: ApplyFeatureEditSpec = typeof selectorOverride === 'string' && selectorOverride.trim() !== synthesis.args
      ? { ...synthesis.spec, rawArgs: selectorOverride.trim() }
      : synthesis.spec;
    if (offsetOptions) {
      spec = { ...spec, offset: offsetOptions };
    }
    if (textOptions) {
      spec = { ...spec, text: textOptions };
    }
    if (newVariables) {
      spec = { ...spec, newVariables };
    }
    await dispatcher.dispatch(res, spec, { success: true, preview: statement });
  } catch (err: any) {
    res.status(500).json({ success: false, reason: err?.message ?? String(err) });
  }
}
