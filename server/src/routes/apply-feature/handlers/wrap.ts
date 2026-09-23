// POST /apply-feature, the wrap create branch.

import type { Request, Response } from 'express';
import {
  extractNumericParams,
  makeProducerNamer,
  renderWrapStatement,
  resolveParamValues,
  type ApplyFeatureEditSpec,
  type WrapEditOptions,
} from '../../../apply-feature-edit/index.ts';
import { validateWrap } from '../validate/wrap.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// Wrap composes a sketch with a picked target face (synthesized into a
// face selector). The sketch is always bound to a variable — wrap() takes
// it as an explicit argument, never consuming the active sketch.
export async function handleWrap(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables } = ctx;
  const request = validateWrap(req.body);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  try {
    const code = fluidCadServer.getCurrentCode();
    // The sketch stays producers[0] — the wrap transform's contract; the
    // face selector's producers follow it.
    const producers: ApplyFeatureEditSpec['producers'] = [{
      line: request.sketch.line,
      column: request.sketch.column,
      featureType: 'sketch',
      nameHint: 's',
      bind: true,
    }];
    const synthOptions = code
      ? {
        namer: await makeProducerNamer(code),
        params: resolveParamValues(
          await extractNumericParams(code),
          fluidCadServer.getParamDefinitions(),
        ),
      }
      : undefined;
    const synthesis = fluidCadServer.synthesizeApplyFeature(
      [request.face], 'wrap', undefined, [], synthOptions,
    );
    if (!synthesis) {
      res.status(404).json({ success: false, reason: 'No rendered scene' });
      return;
    }
    if (!synthesis.ok) {
      res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
      return;
    }
    // The target argument is ONE SceneObject — a multi-part selection
    // has no single-expression rendering.
    if (synthesis.spec.parts.length !== 1) {
      res.status(422).json({ success: false, reason: 'the wrap target must be a single face selection' });
      return;
    }
    if (synthesis.spec.filePath !== request.sketch.filePath) {
      res.status(422).json({ success: false, reason: 'the target face and the sketch come from different files' });
      return;
    }
    const parts = synthesis.spec.parts.map((part: ApplyFeatureEditSpec['parts'][number]) => ({
      ...part,
      producer: part.producer === null ? null : part.producer + producers.length,
      refs: part.refs ? part.refs.map(i => i + producers.length) : part.refs,
    }));
    producers.push(...synthesis.spec.producers);
    const imports = synthesis.spec.imports;
    const faceArgs = synthesis.args;

    const options: WrapEditOptions = {
      op: request.op,
      thickness: request.thickness,
      sketch: { producer: 0 },
      regions: request.regions,
    };
    // Truthful preview name for the sketch: the same resolution the
    // transform runs (reused const, collision-suffixed hint).
    let sketchVar: string | null = null;
    if (code) {
      const namer = await makeProducerNamer(code);
      sketchVar = namer([{ line: request.sketch.line, nameHint: 's', featureType: 'sketch' }])[0];
    }
    const statement = renderWrapStatement(options, sketchVar ?? 's', faceArgs);
    if (preview === true) {
      res.json({ success: true, preview: statement, args: faceArgs ?? undefined, alternatives: synthesis.alternatives });
      return;
    }
    await dispatcher.dispatch(res, {
      feature: 'wrap',
      wrap: options,
      filePath: request.sketch.filePath,
      producers,
      parts,
      imports,
      newVariables,
    }, { success: true, preview: statement });
  } catch (err: any) {
    res.status(500).json({ success: false, reason: err?.message ?? String(err) });
  }
}
