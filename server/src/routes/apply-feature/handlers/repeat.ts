// POST /apply-feature, the repeat create branch.

import type { Request, Response } from 'express';
import {
  renderRepeatAxisExpr,
  renderRepeatPlaneExpr,
  renderRepeatStatement,
  type ApplyFeatureEditSpec,
  type RepeatAxisSpec,
  type RepeatEditOptions,
} from '../../../apply-feature-edit/index.ts';
import type { Pick } from '../picks.ts';
import {
  allocateProducerVars,
  AXIS_PICK_ERRORS,
  makePickSynthesizer,
  makeProducerMerger,
} from '../synthesis.ts';
import { validateRepeat } from '../validate/repeat.ts';
import type { RevolveAxisInput } from '../validate/revolve.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// Repeat replays one or more timeline features linearly, circularly,
// mirrored, or rotated. The targets are feature statements bound to
// variables; every axis reuses the revolve axis inputs (a picked edge
// synthesizes `axis(<selector>)` — one selector part per direction),
// the mirror plane the plane-base inputs (a picked face synthesizes
// `plane(<selector>)`).
export async function handleRepeat(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables } = ctx;
  const request = validateRepeat(req.body);
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

    const targets: RepeatEditOptions['targets'] = request.targets.map(loc => ({
      producer: mergeProducer({
        line: loc.line, column: loc.column,
        featureType: 'feature', nameHint: 'f', bind: true,
      }),
    }));

    const synthesizePick = makePickSynthesizer({
      res, fluidCadServer, code, filePath, mergeProducer, parts, imports,
    });
    const synthesizeInput = (pick: Pick, kind: 'revolve' | 'plane'): Promise<number | null> =>
      synthesizePick(pick, kind, kind === 'plane'
        ? {
          multi: 'the mirror plane must be a single face selection',
          crossFile: 'the mirror face and the targets come from different files',
        }
        : { multi: 'a repeat axis must be a single edge selection', ...AXIS_PICK_ERRORS });

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
      const part = await synthesizeInput(input.pick, 'revolve');
      return part === null ? null : { kind: 'selector', part };
    };

    let axis: RepeatEditOptions['axis'];
    let plane: RepeatEditOptions['plane'];
    let directions: RepeatEditOptions['directions'];
    if (request.kind === 'linear') {
      directions = [];
      for (const direction of request.directions!) {
        const resolved = await axisSpec(direction.axis);
        if (resolved === null) {
          return;
        }
        directions.push({ axis: resolved, count: direction.count, value: direction.value });
      }
    } else if (request.kind === 'mirror') {
      const input = request.plane!;
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
        const part = await synthesizeInput(input.pick, 'plane');
        if (part === null) {
          return;
        }
        plane = { kind: 'selector', part };
      }
    } else {
      const resolved = await axisSpec(request.axis!);
      if (resolved === null) {
        return;
      }
      axis = resolved;
    }

    const options: RepeatEditOptions = {
      kind: request.kind,
      directions,
      spacingMode: request.spacingMode,
      axis,
      plane,
      count: request.count,
      sweep: request.sweep,
      centered: request.centered === true ? true : undefined,
      angle: request.angle,
      targets,
    };
    // Truthful preview: the same allocation walk the transform runs.
    const producerVars = await allocateProducerVars(producers, code);
    const varFor = (i: number): string | null => producerVars[i];
    const inputExprs = request.kind === 'mirror'
      ? [renderRepeatPlaneExpr(plane!, parts, varFor)]
      : request.kind === 'linear'
        ? directions!.map(d => renderRepeatAxisExpr(d.axis, parts, varFor))
        : [renderRepeatAxisExpr(axis!, parts, varFor)];
    const statement = renderRepeatStatement(
      options, inputExprs, targets.map(t => producerVars[t.producer] ?? 'f'),
    );
    if (preview === true) {
      res.json({ success: true, preview: statement });
      return;
    }
    await dispatcher.dispatch(res, {
      feature: 'repeat',
      repeat: options,
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
