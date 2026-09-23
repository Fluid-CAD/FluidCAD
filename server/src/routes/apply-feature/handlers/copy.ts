// POST /apply-feature, the copy create branch.

import type { Request, Response } from 'express';
import {
  renderCopyStatement,
  renderRepeatAxisExpr,
  type ApplyFeatureEditSpec,
  type CopyEditOptions,
  type RepeatAxisSpec,
} from '../../../apply-feature-edit/index.ts';
import type { Pick } from '../picks.ts';
import {
  allocateProducerVars,
  AXIS_PICK_ERRORS,
  makePickSynthesizer,
  makeProducerMerger,
} from '../synthesis.ts';
import { validateCopy } from '../validate/copy.ts';
import type { RevolveAxisInput } from '../validate/revolve.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

export async function handleCopy(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables } = ctx;
  const request = validateCopy(req.body);
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

    const targets: CopyEditOptions['targets'] = request.targets.map(loc => ({
      producer: mergeProducer({
        line: loc.line, column: loc.column,
        featureType: 'feature', nameHint: 'f', bind: true,
      }),
    }));

    const synthesizePick = makePickSynthesizer({
      res, fluidCadServer, code, filePath, mergeProducer, parts, imports,
    });
    const synthesizeInput = (pick: Pick): Promise<number | null> =>
      synthesizePick(pick, 'revolve',
        { multi: 'a copy axis must be a single edge selection', ...AXIS_PICK_ERRORS });

    /** One validated axis input as its spec form; null after refusing. */
    const axisSpec = async (input: RevolveAxisInput): Promise<RepeatAxisSpec | null> => {
      if (input.kind === 'standard') {
        return { kind: 'standard', axis: input.axis };
      }
      if (input.kind === 'axis') {
        return {
          kind: 'axis',
          producer: mergeProducer({
            line: input.loc.line, column: input.loc.column,
            featureType: 'axis', nameHint: 'a', bind: true,
          }),
        };
      }
      const part = await synthesizeInput(input.pick);
      return part === null ? null : { kind: 'selector', part };
    };

    let axis: CopyEditOptions['axis'];
    let directions: CopyEditOptions['directions'];
    if (request.kind === 'linear') {
      directions = [];
      for (const direction of request.directions!) {
        const resolved = await axisSpec(direction.axis);
        if (resolved === null) {
          return;
        }
        directions.push({ axis: resolved, count: direction.count, value: direction.value });
      }
    } else {
      const resolved = await axisSpec(request.axis!);
      if (resolved === null) {
        return;
      }
      axis = resolved;
    }

    const options: CopyEditOptions = {
      kind: request.kind,
      directions,
      spacingMode: request.spacingMode,
      axis,
      count: request.count,
      sweep: request.sweep,
      centered: request.centered === true ? true : undefined,
      skip: request.skip,
      targets,
    };
    // Truthful preview: the same allocation walk the transform runs.
    const producerVars = await allocateProducerVars(producers, code);
    const varFor = (i: number): string | null => producerVars[i];
    const inputExprs = request.kind === 'linear'
      ? directions!.map(d => renderRepeatAxisExpr(d.axis, parts, varFor))
      : [renderRepeatAxisExpr(axis!, parts, varFor)];
    const statement = renderCopyStatement(
      options, inputExprs, targets.map(t => producerVars[t.producer] ?? 'f'),
    );
    if (preview === true) {
      res.json({ success: true, preview: statement });
      return;
    }
    await dispatcher.dispatch(res, {
      feature: 'copy',
      copy: options,
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
