// POST /apply-feature, the copy create branch.

import type { Request, Response } from 'express';
import {
  renderCopyAxisExpr,
  renderCopyStatement,
  type ApplyFeatureEditSpec,
  type CopyAxisSpec,
  type CopyEditOptions,
} from '../../../apply-feature-edit/index.ts';
import type { Pick } from '../picks.ts';
import {
  allocateProducerVars,
  AXIS_PICK_ERRORS,
  makePickSynthesizer,
  makeProducerMerger,
} from '../synthesis.ts';
import { validateCopy, type CopyAxisInput } from '../validate/copy.ts';
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

    // A connector target binds its connector() statement under the
    // connector's own name; a feature target its statement under `f`.
    const targets: CopyEditOptions['targets'] = request.targets.map(target => ({
      producer: mergeProducer({
        line: target.line, column: target.column,
        featureType: target.kind, nameHint: target.kind === 'connector' ? 'c' : 'f', bind: true,
      }),
    }));

    if (request.kind === 'pattern') {
      // The follow form: the repeat binds like any feature target (`const
      // holes = repeat(…)` is reused as written) and stands where the type
      // goes. It and the connectors pin the statement to their part body,
      // so it lands after both.
      const pattern = {
        producer: mergeProducer({
          line: request.pattern!.line, column: request.pattern!.column,
          featureType: 'feature', nameHint: 'r', bind: true,
        }),
      };
      const options: CopyEditOptions = { kind: 'pattern', pattern, targets };
      const producerVars = await allocateProducerVars(producers, code);
      const statement = renderCopyStatement(
        options, [producerVars[pattern.producer] ?? 'r'], targets.map(t => producerVars[t.producer] ?? 'c'),
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
      return;
    }

    const synthesizePick = makePickSynthesizer({
      res, fluidCadServer, code, filePath, mergeProducer, parts, imports,
    });
    const synthesizeInput = (pick: Pick): Promise<number | null> =>
      synthesizePick(pick, 'revolve',
        { multi: 'a copy axis must be a single edge selection', ...AXIS_PICK_ERRORS });

    /** One validated axis input as its spec form; null after refusing. */
    const axisSpec = async (input: CopyAxisInput): Promise<CopyAxisSpec | null> => {
      if (input.kind === 'standard') {
        return { kind: 'standard', axis: input.axis };
      }
      if (input.kind === 'connector') {
        return {
          kind: 'connector',
          producer: mergeProducer({
            line: input.loc.line, column: input.loc.column,
            featureType: 'connector', nameHint: 'c', bind: true,
          }),
          ...(input.slot !== undefined ? { slot: input.slot } : {}),
        };
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
      ? directions!.map(d => renderCopyAxisExpr(d.axis, parts, varFor))
      : [renderCopyAxisExpr(axis!, parts, varFor)];
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
