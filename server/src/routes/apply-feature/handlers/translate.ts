// POST /apply-feature, the translate create branch.

import type { Request, Response } from 'express';
import {
  renderTranslateStatement,
  type TranslateEditOptions,
} from '../../../apply-feature-edit/index.ts';
import { allocateProducerVars, makeProducerMerger } from '../synthesis.ts';
import { validateTranslate } from '../validate/translate.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

export async function handleTranslate(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables } = ctx;
  const request = validateTranslate(req.body);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  try {
    const code = fluidCadServer.getCurrentCode();
    const filePath = request.targets[0].filePath;
    const { producers, merge: mergeProducer } = makeProducerMerger();

    const targets: TranslateEditOptions['targets'] = request.targets.map(loc => ({
      producer: mergeProducer({
        line: loc.line, column: loc.column,
        featureType: 'feature', nameHint: 'f', bind: true,
      }),
    }));

    const options: TranslateEditOptions = {
      translation: request.translation, copy: request.copy, targets,
    };
    // Truthful preview: the same allocation walk the transform runs.
    const producerVars = await allocateProducerVars(producers, code);
    const statement = renderTranslateStatement(options, targets.map(t => producerVars[t.producer] ?? 'f'));
    if (preview === true) {
      res.json({ success: true, preview: statement });
      return;
    }
    await dispatcher.dispatch(res, {
      feature: 'translate',
      translate: options,
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
