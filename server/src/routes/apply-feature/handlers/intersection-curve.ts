// POST /apply-feature, the intersection curve create branch.

import type { Request, Response } from 'express';
import {
  extractNumericParams,
  makeProducerNamer,
  OperandPicks,
  renderIntersectionCurveStatement,
  resolveParamValues,
  type ApplyFeatureEditSpec,
  type IntersectionCurveEditOptions,
  type OperandPick,
} from '../../../apply-feature-edit/index.ts';
import { OperandInputs } from '../operand-inputs.ts';
import type { Pick } from '../picks.ts';
import { allocateProducerVars, makeProducerMerger } from '../synthesis.ts';
import { validateIntersectionCurve } from '../validate/intersection-curve.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// The intersection curve — `intersect(first, second)` outside a sketch —
// takes two rows of surface picks: a surface whole, bound to its variable,
// or faces of bodies, each row's faces synthesized together into selectors.
// It consumes nothing and has no options.
export async function handleIntersectionCurve(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables, activePartFor } = ctx;
  const request = validateIntersectionCurve(req.body);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  try {
    const code = fluidCadServer.getCurrentCode();
    const merger = makeProducerMerger();
    const parts: ApplyFeatureEditSpec['parts'] = [];
    const imports = new Set<string>();
    const files = OperandInputs.statements([...request.first, ...request.second]).map(loc => loc.filePath);

    // Built on the first row that picks faces — a row of whole surfaces
    // runs no synthesis.
    let options: { namer: Awaited<ReturnType<typeof makeProducerNamer>>; params: { name: string; value: number }[] } | undefined;
    const synthesize = async (picks: Pick[]): Promise<number[] | null> => {
      if (!options && code) {
        options = {
          namer: await makeProducerNamer(code, await ctx.currentCallees()),
          params: resolveParamValues(await extractNumericParams(code), fluidCadServer.getParamDefinitions()),
        };
      }
      const synthesis = fluidCadServer.synthesizeApplyFeature(picks, 'intersection-curve', undefined, [], options);
      if (!synthesis) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return null;
      }
      if (!synthesis.ok) {
        res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
        return null;
      }
      files.push(synthesis.spec.filePath);
      const remap: number[] = synthesis.spec.producers.map(merger.merge);
      const added: number[] = [];
      for (const part of synthesis.spec.parts as ApplyFeatureEditSpec['parts']) {
        added.push(parts.length);
        parts.push({
          ...part,
          producer: part.producer === null ? null : remap[part.producer],
          refs: part.refs ? part.refs.map(i => remap[i]) : part.refs,
        });
      }
      for (const symbol of synthesis.spec.imports as string[]) {
        imports.add(symbol);
      }
      return added;
    };

    const first = await OperandInputs.resolve(request.first, 'surface', merger, synthesize);
    if (!first) {
      return;
    }
    const second = await OperandInputs.resolve(request.second, 'surface', merger, synthesize);
    if (!second) {
      return;
    }
    if (!OperandInputs.sameFile(files)) {
      res.status(422).json({ success: false, reason: 'the two selections come from different files' });
      return;
    }
    const filePath = files[0] ?? fluidCadServer.getCurrentFileName();
    if (!filePath) {
      res.status(404).json({ success: false, reason: 'No rendered scene' });
      return;
    }

    const intersectionCurve: IntersectionCurveEditOptions = { first, second };
    // Truthful preview names: the same allocation walk the transform runs.
    const producerVars = await allocateProducerVars(merger.producers, code, await ctx.currentCallees());
    const statement = renderIntersectionCurveStatement(intersectionCurve, parts, i => producerVars[i]);
    if (preview === true) {
      res.json({ success: true, preview: statement });
      return;
    }
    const activePart = activePartFor(filePath);
    await dispatcher.dispatch(res, {
      feature: 'intersection-curve',
      intersectionCurve,
      filePath,
      producers: merger.producers,
      parts,
      imports: [...imports],
      newVariables,
      ...(activePart ? { activePart } : {}),
    }, { success: true, preview: statement });
  } catch (err: any) {
    res.status(500).json({ success: false, reason: err?.message ?? String(err) });
  }
}
