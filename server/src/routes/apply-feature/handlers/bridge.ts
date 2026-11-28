// POST /apply-feature, the bridge create branch.

import type { Request, Response } from 'express';
import {
  BridgeEnds,
  renderBridgeStatement,
  type ApplyFeatureEditSpec,
  type BridgeEditOptions,
} from '../../../apply-feature-edit/index.ts';
import { EndInputs } from '../end-inputs.ts';
import { OperandInputs } from '../operand-inputs.ts';
import { allocateProducerVars, makeProducerMerger } from '../synthesis.ts';
import { validateBridge } from '../validate/bridge.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// The bridge — `bridge(from, to)` — takes two ends, each the start or the
// end of a picked edge (synthesized into its selector), of a curve (its
// statement bound to its variable), or a picked vertex (named by the point
// synthesis: a solid's corner as an edge's end, a sketch's vertex as its
// sketch point, exported from the sketch by the transform), then the
// continuity at each end and the two magnitudes.
export async function handleBridge(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables, activePartFor } = ctx;
  const request = validateBridge(req.body);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  try {
    const code = fluidCadServer.getCurrentCode();
    const { producers, merge } = makeProducerMerger();
    const parts: ApplyFeatureEditSpec['parts'] = [];
    const imports = new Set<string>();
    const files: string[] = [];
    const ends = await EndInputs.resolve([request.from, request.to], { merge, parts, imports, files }, {
      server: fluidCadServer,
      feature: 'bridge',
      code,
      callees: ctx.currentCallees,
      refuse: (status, reason, pick) => {
        res.status(status).json({ success: false, reason, ...(pick !== undefined ? { pick } : {}) });
      },
    });
    if (!ends) {
      return;
    }
    if (!OperandInputs.sameFile(files)) {
      res.status(422).json({ success: false, reason: 'the two ends come from different files' });
      return;
    }
    const filePath = files[0] ?? fluidCadServer.getCurrentFileName();
    if (!filePath) {
      res.status(404).json({ success: false, reason: 'No rendered scene' });
      return;
    }
    const bridge: BridgeEditOptions = {
      from: ends[0],
      to: ends[1],
      startContinuity: request.startContinuity,
      endContinuity: request.endContinuity,
      startMagnitude: request.startMagnitude,
      endMagnitude: request.endMagnitude,
    };
    const activePart = activePartFor(filePath);
    const spec: ApplyFeatureEditSpec = {
      feature: 'bridge', bridge, filePath, producers, parts,
      imports: [...imports], newVariables,
      ...(activePart ? { activePart } : {}),
    };
    // Truthful preview: stage the sketch point exports the way the
    // transform will, then name producers the way its binding walk does.
    const staged = code ? await BridgeEnds.prepare(code, spec) : { code, spec };
    if ('error' in staged) {
      res.status(422).json({ success: false, reason: staged.error });
      return;
    }
    const vars = await allocateProducerVars(staged.spec.producers, staged.code, await ctx.currentCallees());
    const statement = renderBridgeStatement(staged.spec.bridge!, staged.spec.parts, i => vars[i] ?? null);
    if (preview === true) {
      res.json({ success: true, preview: statement });
      return;
    }
    await dispatcher.dispatch(res, spec, { success: true, preview: statement });
  } catch (err) {
    res.status(500).json({ success: false, reason: (err as { message?: unknown } | null)?.message ?? String(err) });
  }
}
