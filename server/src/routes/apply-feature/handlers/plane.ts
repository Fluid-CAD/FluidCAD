// POST /apply-feature, the plane create branch.

import type { Request, Response } from 'express';
import {
  extractNumericParams,
  renderPlaneBaseExprs,
  renderPlaneStatement,
  resolveParamValues,
  type ApplyFeatureEditSpec,
  type PlaneEditOptions,
} from '../../../apply-feature-edit/index.ts';
import { allocateProducerVars, makeProducerMerger } from '../synthesis.ts';
import { validatePlane } from '../validate/plane.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// Plane takes one base (offset) or two (mid) — standard planes, picked
// faces/edges, or existing plane features, mixed freely. Picks run
// synthesis one at a time like loft profiles, so each base keeps its own
// selector part.
export async function handlePlane(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables, activePartFor } = ctx;
  const request = validatePlane(req.body);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  try {
    const code = fluidCadServer.getCurrentCode();
    // Built lazily on the first pick base — a standard/plane-only request
    // never runs synthesis. Only `params` is passed: synthesis's own
    // preview strings are discarded (bases re-render from the parts).
    let synthOptions: { params: { name: string; value: number }[] } | undefined;
    let synthOptionsReady = false;

    const { producers, merge: mergeProducer } = makeProducerMerger();
    const parts: ApplyFeatureEditSpec['parts'] = [];
    const imports = new Set<string>();
    const bases: PlaneEditOptions['bases'] = [];
    let filePath: string | null = null;

    for (const base of request.bases) {
      if (base.kind === 'standard') {
        bases.push({ kind: 'standard', plane: base.plane });
        continue;
      }
      if (base.kind === 'plane' || base.kind === 'wire') {
        if (filePath !== null && base.loc.filePath !== filePath) {
          res.status(422).json({ success: false, reason: 'the plane bases come from features in different files' });
          return;
        }
        filePath = base.loc.filePath;
        bases.push(base.kind === 'plane'
          ? {
            kind: 'plane',
            producer: mergeProducer({
              line: base.loc.line, column: base.loc.column,
              featureType: 'plane', nameHint: 'p', bind: true,
            }),
          }
          : {
            kind: 'wire',
            producer: mergeProducer({
              line: base.loc.line, column: base.loc.column,
              featureType: 'wire', nameHint: 'e', bind: true,
            }),
          });
        continue;
      }
      if (!synthOptionsReady) {
        synthOptionsReady = true;
        if (code) {
          synthOptions = {
            params: resolveParamValues(
              await extractNumericParams(code),
              fluidCadServer.getParamDefinitions(),
            ),
          };
        }
      }
      const synthesis = fluidCadServer.synthesizeApplyFeature(
        [base.pick], 'plane', undefined, [], synthOptions,
      );
      if (!synthesis) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return;
      }
      if (!synthesis.ok) {
        res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
        return;
      }
      if (synthesis.spec.parts.length !== 1) {
        res.status(422).json({ success: false, reason: 'a plane base must be a single face or edge selection' });
        return;
      }
      if (filePath !== null && synthesis.spec.filePath !== filePath) {
        res.status(422).json({ success: false, reason: 'the plane bases come from features in different files' });
        return;
      }
      filePath = synthesis.spec.filePath;
      const remap = synthesis.spec.producers.map(mergeProducer);
      const part = synthesis.spec.parts[0];
      parts.push({
        ...part,
        producer: part.producer === null ? null : remap[part.producer],
        refs: part.refs ? part.refs.map((i: number) => remap[i]) : part.refs,
      });
      for (const symbol of synthesis.spec.imports) {
        imports.add(symbol);
      }
      bases.push({ kind: 'selector', part: parts.length - 1 });
    }

    // Standard-only bases reference no existing statement — the edit
    // still needs a file to land in.
    if (filePath === null) {
      filePath = fluidCadServer.getCurrentFileName();
      if (!filePath) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return;
      }
    }

    const options: PlaneEditOptions = {
      type: request.type,
      offset: request.offset,
      rotateX: request.rotateX,
      rotateY: request.rotateY,
      rotateZ: request.rotateZ,
      rotationAxes: request.rotationAxes,
      position: request.position,
      bases,
    };
    const producerVars = await allocateProducerVars(producers, code);
    const statement = renderPlaneStatement(
      options, renderPlaneBaseExprs(options, parts, i => producerVars[i]),
    );
    if (preview === true) {
      res.json({ success: true, preview: statement });
      return;
    }
    const activePart = activePartFor(filePath);
    await dispatcher.dispatch(res, {
      feature: 'plane',
      plane: options,
      filePath,
      producers,
      parts,
      imports: [...imports],
      newVariables,
      ...(activePart ? { activePart } : {}),
    }, { success: true, preview: statement });
  } catch (err: any) {
    res.status(500).json({ success: false, reason: err?.message ?? String(err) });
  }
}
