// POST /apply-feature, the helix create branch.

import type { Request, Response } from 'express';
import {
  extractNumericParams,
  makeProducerNamer,
  renderHelixSourceExpr,
  renderHelixStatement,
  resolveParamValues,
  type ApplyFeatureEditSpec,
  type HelixEditOptions,
  type HelixSourceSpec,
} from '../../../apply-feature-edit/index.ts';
import { validateHelix } from '../validate/helix.ts';
import { AxisInputs } from '../axis-inputs.ts';
import { allocateProducerVars } from '../synthesis.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// Helix builds a wire around an axis (a standard world axis, an existing
// axis statement bound to a variable, a connector — its Z axis — or a
// picked edge synthesized into `axis(<selector>)`) or on a
// cylindrical/conical face (its selector on its own). It consumes no
// sketch, so there is no profile producer.
export async function handleHelix(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables, activePartFor } = ctx;
  const request = validateHelix(req.body);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  try {
    const code = fluidCadServer.getCurrentCode();
    const producers: ApplyFeatureEditSpec['producers'] = [];
    let parts: ApplyFeatureEditSpec['parts'] = [];
    let imports: string[] = [];
    let source: HelixSourceSpec;
    let sourceArgs: string | null = null;
    let alternatives: string[] | undefined;
    let filePath: string | null = null;

    if (request.source.kind === 'edge' || request.source.kind === 'face') {
      const options = code
        ? {
          namer: await makeProducerNamer(code, await ctx.currentCallees()),
          params: resolveParamValues(
            await extractNumericParams(code),
            fluidCadServer.getParamDefinitions(),
          ),
        }
        : undefined;
      const synthesis = fluidCadServer.synthesizeApplyFeature(
        [request.source.pick], 'helix', undefined, [], options,
      );
      if (!synthesis) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return;
      }
      if (!synthesis.ok) {
        res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
        return;
      }
      // The source argument is ONE SceneObject — a multi-part selection
      // has no single-expression rendering. No profile precedes it, so the
      // synthesized parts and producers ride the list from index 0.
      if (synthesis.spec.parts.length !== 1) {
        res.status(422).json({ success: false, reason: 'the helix source must be a single edge or face selection' });
        return;
      }
      parts = synthesis.spec.parts;
      producers.push(...synthesis.spec.producers);
      imports = request.source.kind === 'edge'
        ? [...synthesis.spec.imports, 'axis']
        : synthesis.spec.imports;
      sourceArgs = synthesis.args;
      alternatives = synthesis.alternatives;
      filePath = synthesis.spec.filePath;
      source = { kind: request.source.kind };
    } else {
      source = AxisInputs.bind(request.source, AxisInputs.appender(producers));
      filePath = AxisInputs.fileOf(request.source);
    }

    // A standard axis references no existing statement — the helix still
    // needs a file to land in.
    if (filePath === null) {
      filePath = fluidCadServer.getCurrentFileName();
      if (!filePath) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return;
      }
    }

    const options: HelixEditOptions = {
      source,
      radius: request.radius,
      endRadius: request.endRadius,
      pitch: request.pitch,
      turns: request.turns,
      height: request.height,
      startOffset: request.startOffset,
      endOffset: request.endOffset,
    };

    // Truthful preview name for a bound axis statement or connector — the
    // same allocation walk the transform runs.
    const producerVars = await allocateProducerVars(producers, code, await ctx.currentCallees());
    const sourceExpr = source.kind === 'edge'
      ? `axis(${sourceArgs})`
      : source.kind === 'face'
        ? sourceArgs ?? ''
        : renderHelixSourceExpr(source, parts, i => producerVars[i]);
    const statement = renderHelixStatement(options, sourceExpr);
    if (preview === true) {
      res.json({ success: true, preview: statement, args: sourceArgs ?? undefined, alternatives });
      return;
    }
    const activePart = activePartFor(filePath);
    await dispatcher.dispatch(res, {
      feature: 'helix',
      helix: options,
      filePath,
      producers,
      parts,
      imports,
      newVariables,
      ...(activePart ? { activePart } : {}),
    }, { success: true, preview: statement });
  } catch (err: any) {
    res.status(500).json({ success: false, reason: err?.message ?? String(err) });
  }
}
