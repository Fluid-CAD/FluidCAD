// POST /apply-feature, the rib create branch.

import type { Request, Response } from 'express';
import { renderRibStatement, type RibEditOptions } from '../../../apply-feature-edit/index.ts';
import { normalizePath } from '../../../normalize-path.ts';
import { allocateProducerVars, makeProducerMerger } from '../synthesis.ts';
import { validateRib } from '../validate/rib.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

export async function handleRib(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables } = ctx;
  const request = validateRib(req.body);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  for (const loc of request.scope) {
    if (normalizePath(loc.filePath) !== normalizePath(request.spine.filePath)) {
      res.status(422).json({ success: false, reason: 'a scope solid and the spine sketch come from different files' });
      return;
    }
  }
  try {
    const code = fluidCadServer.getCurrentCode();
    // The spine stays producers[0] in both modes — the transform's rib
    // contract; the scope solids' producers follow it.
    const { producers, merge: mergeProducer } = makeProducerMerger();
    mergeProducer({
      line: request.spine.line, column: request.spine.column,
      featureType: 'sketch', nameHint: 's', bind: request.spine.mode === 'bound',
    });
    const scope = request.scope.map(loc => mergeProducer({
      line: loc.line, column: loc.column,
      featureType: 'feature', nameHint: 'f', bind: true,
    }));
    const options: RibEditOptions = {
      op: request.op,
      thickness: request.thickness,
      parallel: request.parallel,
      extend: request.extend,
      draft: request.draft,
      spine: request.spine.mode === 'bound' ? 'bound' : 'implicit',
      scope,
    };
    // Truthful preview names: the same resolution the transform runs
    // (reused consts, collision-suffixed hints).
    const names = await allocateProducerVars(producers, code);
    const statement = renderRibStatement(
      options,
      request.spine.mode === 'bound' ? names[0] ?? 's' : null,
      scope.map(index => names[index] ?? 'f'),
    );
    if (preview === true) {
      res.json({ success: true, preview: statement });
      return;
    }
    await dispatcher.dispatch(res, {
      feature: 'rib',
      rib: options,
      filePath: request.spine.filePath,
      producers,
      parts: [],
      imports: [],
      newVariables,
    }, { success: true, preview: statement });
  } catch (err: any) {
    res.status(500).json({ success: false, reason: err?.message ?? String(err) });
  }
}
