// POST /apply-feature, the color create branch.

import type { Request, Response } from 'express';
import {
  extractNumericParams,
  makeProducerNamer,
  renderColorStatement,
  resolveParamValues,
  type ApplyFeatureEditSpec,
  type ColorEditOptions,
} from '../../../apply-feature-edit/index.ts';
import { allocateProducerVars, makeProducerMerger } from '../synthesis.ts';
import { validateColor } from '../validate/color.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

/**
 * A colour paints whole objects — the feature statements its targets name,
 * bound to variables like a boolean's (the Solid tab) — or the faces the
 * picks synthesize into selectors, like a shell's (the Face tab). Either
 * way the route composes `color('<value>', …)` itself: the kernel's
 * synthesis only answers the selector arguments.
 */
export async function handleColor(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables } = ctx;
  const request = validateColor(req.body);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  try {
    const code = fluidCadServer.getCurrentCode();
    if (request.paint.kind === 'solids') {
      const { producers, merge: mergeProducer } = makeProducerMerger();
      const options: ColorEditOptions = {
        value: request.value,
        targets: request.paint.targets.map(loc => ({
          producer: mergeProducer({
            line: loc.line, column: loc.column,
            featureType: 'feature', nameHint: 'f', bind: true,
          }),
        })),
      };
      // Truthful preview: the same allocation walk the transform runs.
      const producerVars = await allocateProducerVars(producers, code, await ctx.currentCallees());
      const statement = renderColorStatement(
        options.value, options.targets.map(t => producerVars[t.producer] ?? 'f').join(', '),
      );
      if (preview === true) {
        res.json({ success: true, preview: statement });
        return;
      }
      await dispatcher.dispatch(res, {
        feature: 'color',
        color: options,
        filePath: request.paint.targets[0].filePath,
        producers,
        parts: [],
        imports: [],
        newVariables,
      }, { success: true, preview: statement });
      return;
    }

    // Source-derived context from the live buffer, as for every selector
    // feature: the namer keeps previewed variable names truthful to the
    // transform, params let synthesized constants render as the user's
    // own variables.
    const synthOptions = code
      ? {
        namer: await makeProducerNamer(code, await ctx.currentCallees()),
        params: resolveParamValues(
          await extractNumericParams(code),
          fluidCadServer.getParamDefinitions(),
        ),
      }
      : undefined;
    const synthesis = fluidCadServer.synthesizeApplyFeature(
      request.paint.picks, 'color', undefined, request.paint.chains, synthOptions,
    );
    if (!synthesis) {
      res.status(404).json({ success: false, reason: 'No rendered scene' });
      return;
    }
    if (!synthesis.ok) {
      res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
      return;
    }
    // The user's expression text wins only when it differs from what the
    // picks synthesize — the create path's contract.
    const override = request.paint.selectorOverride;
    const rawArgs = override !== undefined && override !== synthesis.args ? override : undefined;
    const statement = renderColorStatement(request.value, rawArgs ?? synthesis.args);
    if (preview === true) {
      res.json({
        success: true,
        preview: statement,
        args: synthesis.args,
        alternatives: synthesis.alternatives,
      });
      return;
    }
    const spec: ApplyFeatureEditSpec = {
      ...synthesis.spec,
      feature: 'color',
      color: { value: request.value, targets: [] },
      ...(rawArgs !== undefined ? { rawArgs } : {}),
      ...(newVariables ? { newVariables } : {}),
    };
    await dispatcher.dispatch(res, spec, { success: true, preview: statement });
  } catch (err: any) {
    res.status(500).json({ success: false, reason: err?.message ?? String(err) });
  }
}
