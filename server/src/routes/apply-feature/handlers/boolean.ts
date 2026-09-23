// POST /apply-feature, the boolean create branch.

import type { Request, Response } from 'express';
import { renderBooleanStatement, type BooleanEditOptions } from '../../../apply-feature-edit/index.ts';
import { allocateProducerVars, makeProducerMerger } from '../synthesis.ts';
import { validateBoolean } from '../validate/boolean.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

export async function handleBoolean(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables } = ctx;
  const request = validateBoolean(req.body);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  try {
    const code = fluidCadServer.getCurrentCode();
    const filePath = request.targets[0].filePath;
    const { producers, merge: mergeProducer } = makeProducerMerger();

    const options: BooleanEditOptions = {
      kind: request.kind,
      targets: request.targets.map(loc => ({
        producer: mergeProducer({
          line: loc.line, column: loc.column,
          featureType: 'feature', nameHint: 'f', bind: true,
        }),
      })),
    };
    // Truthful preview: the same allocation walk the transform runs.
    const producerVars = await allocateProducerVars(producers, code);
    const statement = renderBooleanStatement(
      options.kind, options.targets.map(t => producerVars[t.producer] ?? 'f'),
    );
    if (preview === true) {
      res.json({ success: true, preview: statement });
      return;
    }
    await dispatcher.dispatch(res, {
      feature: 'boolean',
      boolean: options,
      filePath,
      producers,
      parts: [],
      imports: [],
      newVariables,
    }, { success: true, preview: statement });
  } catch (err: any) {
    res.status(500).json({ success: false, reason: err?.message ?? String(err) });
  }
}
