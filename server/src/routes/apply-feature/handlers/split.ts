// POST /apply-feature, the split create branch.

import type { Request, Response } from 'express';
import {
  renderSplitPlaneExpr,
  renderSplitStatement,
  SplitSeeds,
  type ApplyFeatureEditSpec,
  type SplitEditOptions,
  type SplitPlaneSpec,
} from '../../../apply-feature-edit/index.ts';
import type { Pick } from '../picks.ts';
import { allocateProducerVars, makePickSynthesizer, makeProducerMerger } from '../synthesis.ts';
import { validateSplit } from '../validate/split.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// A split names its cut — a standard origin plane, an existing plane feature,
// a picked face synthesized into `plane(<selector>)`, or a sketched line
// exported from its sketch as `s.geometries.l` — plus the solids it parts
// (none for every solid in scope), the side it keeps and the plane offset.
// A split of every solid cuts the solids built before it in its scope, so
// with no target pinning a scope it lands at the end of the timeline's
// active part (a top-level split would build before the lazy part and see
// nothing); anything naming a statement lands after its producers.
export async function handleSplit(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables, activePartFor } = ctx;
  const request = validateSplit(req.body);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  try {
    const code = fluidCadServer.getCurrentCode();
    const filePath = request.filePath;
    const { producers, merge: mergeProducer } = makeProducerMerger();
    const parts: ApplyFeatureEditSpec['parts'] = [];
    const imports = new Set<string>();

    const targets: SplitEditOptions['targets'] = request.targets.map(loc => ({
      producer: mergeProducer({
        line: loc.line, column: loc.column,
        featureType: 'feature', nameHint: 'f', bind: true,
      }),
    }));

    const synthesizePick = makePickSynthesizer({
      res, fluidCadServer, code, filePath, mergeProducer, parts, imports,
    });
    const synthesizeFace = (pick: Pick): Promise<number | null> =>
      synthesizePick(pick, 'plane', {
        multi: 'the split plane must be a single face selection',
        crossFile: 'the split face and the targets come from different files',
      });

    let plane: SplitPlaneSpec;
    // The preview's rendering of the cut: the staged seed's expression is
    // only known after a dry run of the export.
    let previewPlaneExpr: string | null = null;
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
    } else if (input.kind === 'face') {
      const part = await synthesizeFace(input.pick);
      if (part === null) {
        return;
      }
      plane = { kind: 'selector', part };
    } else {
      plane = {
        kind: 'sketchLine',
        producer: mergeProducer({
          line: input.sketch.line, column: input.sketch.column,
          featureType: 'sketch', nameHint: 's', bind: true,
        }),
        target: { line: input.line.line },
      };
      if (!code) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return;
      }
      const expression = await SplitSeeds.previewExpression(
        code, filePath, { line: input.sketch.line, column: input.sketch.column }, { line: input.line.line },
      );
      if (typeof expression !== 'string') {
        res.status(422).json({ success: false, reason: expression.error });
        return;
      }
      previewPlaneExpr = expression;
    }

    const options: SplitEditOptions = { plane, keep: request.keep, offset: request.offset, targets };
    // Truthful preview: the same allocation walk the transform runs.
    const producerVars = await allocateProducerVars(producers, code);
    const varFor = (i: number): string | null => producerVars[i];
    const statement = renderSplitStatement(
      options,
      previewPlaneExpr ?? renderSplitPlaneExpr(plane, parts, varFor),
      targets.map(t => producerVars[t.producer] ?? 'f'),
    );
    if (preview === true) {
      res.json({ success: true, preview: statement });
      return;
    }
    const activePart = activePartFor(filePath);
    await dispatcher.dispatch(res, {
      feature: 'split',
      split: options,
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
