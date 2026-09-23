// POST /apply-feature, the mirror create branch.

import type { Request, Response } from 'express';
import {
  renderMirrorStatement,
  renderRepeatPlaneExpr,
  type ApplyFeatureEditSpec,
  type MirrorEditOptions,
  type RepeatPlaneSpec,
} from '../../../apply-feature-edit/index.ts';
import type { Pick } from '../picks.ts';
import { allocateProducerVars, makePickSynthesizer, makeProducerMerger } from '../synthesis.ts';
import { validateMirror } from '../validate/mirror.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// The 3D mirror; the in-sketch form rides the sketchEntities branch below.
export async function handleMirror(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables } = ctx;
  const request = validateMirror(req.body);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  try {
    const code = fluidCadServer.getCurrentCode();
    const filePath = request.targets[0].filePath;
    const { producers, merge: mergeProducer } = makeProducerMerger();
    const parts: ApplyFeatureEditSpec['parts'] = [];
    const imports = new Set<string>();

    const targets: MirrorEditOptions['targets'] = request.targets.map(loc => ({
      producer: mergeProducer({
        line: loc.line, column: loc.column,
        featureType: 'feature', nameHint: 'f', bind: true,
      }),
    }));

    const synthesizePick = makePickSynthesizer({
      res, fluidCadServer, code, filePath, mergeProducer, parts, imports,
    });
    // The picked mirror face synthesizes into its own selector part — the
    // repeat mirror's exact input, through the same single-selection
    // 'plane' synthesis kind.
    const synthesizeFace = (pick: Pick): Promise<number | null> =>
      synthesizePick(pick, 'plane', {
        multi: 'the mirror plane must be a single face selection',
        crossFile: 'the mirror face and the targets come from different files',
      });

    let plane: RepeatPlaneSpec;
    const input = request.plane;
    if (input.kind === 'standard') {
      plane = { kind: 'standard', plane: input.plane };
    } else if (input.kind === 'plane') {
      plane = {
        kind: 'plane',
        producer: mergeProducer({
          line: input.loc.line, column: input.loc.column,
          featureType: 'plane', nameHint: 'p', bind: true,
        }),
      };
    } else {
      const part = await synthesizeFace(input.pick);
      if (part === null) {
        return;
      }
      plane = { kind: 'selector', part };
    }

    const options: MirrorEditOptions = { plane, op: request.op, targets };
    // Truthful preview: the same allocation walk the transform runs.
    const producerVars = await allocateProducerVars(producers, code);
    const varFor = (i: number): string | null => producerVars[i];
    const statement = renderMirrorStatement(
      options,
      renderRepeatPlaneExpr(plane, parts, varFor),
      targets.map(t => producerVars[t.producer] ?? 'f'),
    );
    if (preview === true) {
      res.json({ success: true, preview: statement });
      return;
    }
    await dispatcher.dispatch(res, {
      feature: 'mirror',
      mirror: options,
      filePath,
      producers,
      parts,
      imports: [...imports],
      newVariables,
    }, { success: true, preview: statement });
  } catch (err: any) {
    res.status(500).json({ success: false, reason: err?.message ?? String(err) });
  }
}
