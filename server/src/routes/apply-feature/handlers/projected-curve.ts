// POST /apply-feature, the projected curve create branch.

import type { Request, Response } from 'express';
import {
  Directions,
  extractNumericParams,
  makeProducerNamer,
  OperandPicks,
  renderProjectedCurveStatement,
  resolveParamValues,
  type ApplyFeatureEditSpec,
  type DirectionSpec,
  type OperandPick,
  type ProjectedCurveEditOptions,
} from '../../../apply-feature-edit/index.ts';
import { DirectionInputs } from '../direction-inputs.ts';
import { OperandInputs } from '../operand-inputs.ts';
import type { Pick } from '../picks.ts';
import { allocateProducerVars, makeProducerMerger } from '../synthesis.ts';
import { validateProjectedCurve } from '../validate/projected-curve.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// The projected curve — `project(source, target)` outside a sketch — takes a
// row of curve picks (a sketch or a curve whole, bound to its variable, or
// edges of bodies) and a row of surface picks (a surface whole, or faces of
// bodies), each row's edges or faces synthesized together into selectors,
// then its options: the mode, the direction (a literal, a statement bound to
// its variable, or a picked edge or face synthesized into its selector) and
// what is kept.
export async function handleProjectedCurve(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables, activePartFor } = ctx;
  const request = validateProjectedCurve(req.body);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  try {
    const code = fluidCadServer.getCurrentCode();
    const merger = makeProducerMerger();
    const parts: ApplyFeatureEditSpec['parts'] = [];
    const imports = new Set<string>();
    const directionSite = request.direction ? DirectionInputs.statement(request.direction) : null;
    const files = [
      ...OperandInputs.statements([...request.rows.source, ...request.rows.target]),
      ...(directionSite ? [directionSite] : []),
    ].map(loc => loc.filePath);

    // Built on the first pick that needs synthesis — a request of whole
    // objects and literals runs none.
    let options: { namer: Awaited<ReturnType<typeof makeProducerNamer>>; params: { name: string; value: number }[] } | undefined;
    const synthesize = async (picks: Pick[]): Promise<number[] | null> => {
      if (!options && code) {
        options = {
          namer: await makeProducerNamer(code, await ctx.currentCallees()),
          params: resolveParamValues(await extractNumericParams(code), fluidCadServer.getParamDefinitions()),
        };
      }
      const synthesis = fluidCadServer.synthesizeApplyFeature(picks, 'projected-curve', undefined, [], options);
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

    const source = await OperandInputs.resolve(request.rows.source, 'curve', merger, synthesize);
    if (!source) {
      return;
    }
    const target = await OperandInputs.resolve(request.rows.target, 'surface', merger, synthesize);
    if (!target) {
      return;
    }
    let direction: DirectionSpec | null = null;
    if (request.direction) {
      direction = await DirectionInputs.resolve(request.direction, merger.merge, synthesize, reason => {
        res.status(422).json({ success: false, reason });
      });
      if (!direction) {
        return;
      }
    }
    if (!OperandInputs.sameFile(files)) {
      res.status(422).json({ success: false, reason: 'the curves, the faces and the direction come from different files' });
      return;
    }
    const filePath = files[0] ?? fluidCadServer.getCurrentFileName();
    if (!filePath) {
      res.status(404).json({ success: false, reason: 'No rendered scene' });
      return;
    }

    const projectedCurve: ProjectedCurveEditOptions = {
      source, target, mode: request.mode, direction, keep: request.keep,
    };
    // Truthful preview names: the same allocation walk the transform runs.
    const producerVars = await allocateProducerVars(merger.producers, code, await ctx.currentCallees());
    const statement = renderProjectedCurveStatement(projectedCurve, parts, i => producerVars[i]);
    if (preview === true) {
      res.json({ success: true, preview: statement });
      return;
    }
    const activePart = activePartFor(filePath);
    await dispatcher.dispatch(res, {
      feature: 'projected-curve',
      projectedCurve,
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
