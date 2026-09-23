// POST /apply-feature, the rotate create branch.

import type { Request, Response } from 'express';
import {
  renderRepeatAxisExpr,
  renderRotateStatement,
  type ApplyFeatureEditSpec,
  type RotateEditOptions,
} from '../../../apply-feature-edit/index.ts';
import {
  allocateProducerVars,
  AXIS_PICK_ERRORS,
  makePickSynthesizer,
  makeProducerMerger,
} from '../synthesis.ts';
import { validateRotate } from '../validate/rotate.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

export async function handleRotate(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables } = ctx;
  const request = validateRotate(req.body);
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

    const targets: RotateEditOptions['targets'] = request.targets.map(loc => ({
      producer: mergeProducer({
        line: loc.line, column: loc.column,
        featureType: 'feature', nameHint: 'f', bind: true,
      }),
    }));

    const synthesizePick = makePickSynthesizer({
      res, fluidCadServer, code, filePath, mergeProducer, parts, imports,
    });

    let axis: RotateEditOptions['axis'];
    const input = request.axis;
    if (input.kind === 'standard') {
      axis = { kind: 'standard', axis: input.axis };
    } else if (input.kind === 'axis') {
      axis = {
        kind: 'axis',
        producer: mergeProducer({
          line: input.loc.line, column: input.loc.column,
          featureType: 'axis', nameHint: 'a', bind: true,
        }),
      };
    } else {
      const part = await synthesizePick(input.pick, 'revolve',
        { multi: 'a rotate axis must be a single edge selection', ...AXIS_PICK_ERRORS });
      if (part === null) {
        return;
      }
      axis = { kind: 'selector', part };
    }

    const options: RotateEditOptions = {
      axis, angle: request.angle, copy: request.copy, targets,
    };
    // Truthful preview: the same allocation walk the transform runs.
    const producerVars = await allocateProducerVars(producers, code);
    const varFor = (i: number): string | null => producerVars[i];
    const statement = renderRotateStatement(
      options,
      renderRepeatAxisExpr(axis, parts, varFor),
      targets.map(t => producerVars[t.producer] ?? 'f'),
    );
    if (preview === true) {
      res.json({ success: true, preview: statement });
      return;
    }
    await dispatcher.dispatch(res, {
      feature: 'rotate',
      rotate: options,
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
