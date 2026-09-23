// POST /apply-feature, pick-less sketch: a sketch on an origin plane or an existing plane statement.

import type { Request, Response } from 'express';
import type { ApplyFeatureEditSpec } from '../../../apply-feature-edit/index.ts';
import { validateSketchLoc } from '../locations.ts';
import { allocateProducerVars } from '../synthesis.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// A pick-less sketch: no face selector — a sketch on an origin plane or
// an existing plane() feature, appended after the file's last statement.
// No synthesis is involved; `plane` picks an origin target
// ('xy'/'xz'/'yz'), `planeRef` an existing plane statement by call site
// (bound to a variable — `sketch(p, () => {})`), absent defaults to xy.
export async function handlePlaneSketch(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, activePartFor } = ctx;
  const plane = req.body?.plane;
  if (plane !== undefined && plane !== 'xy' && plane !== 'xz' && plane !== 'yz') {
    res.status(400).json({ error: 'plane must be "xy", "xz" or "yz"' });
    return;
  }
  if (req.body?.planeRef !== undefined) {
    const planeRef = validateSketchLoc(req.body.planeRef);
    if (!planeRef) {
      res.status(400).json({ error: 'planeRef must be {filePath, line, column} of the plane feature' });
      return;
    }
    if (plane !== undefined) {
      res.status(400).json({ error: 'plane and planeRef are mutually exclusive' });
      return;
    }
    try {
      const producers: ApplyFeatureEditSpec['producers'] = [{
        line: planeRef.line, column: planeRef.column,
        featureType: 'plane', nameHint: 'p', bind: true,
      }];
      const producerVars = await allocateProducerVars(producers, fluidCadServer.getCurrentCode());
      const statement = `sketch(${producerVars[0] ?? 'p'}, () => {\n\n})`;
      if (preview === true) {
        res.json({ success: true, preview: statement, args: '' });
        return;
      }
      await dispatcher.dispatch(res, {
        feature: 'sketch', sketchOnPlane: true, filePath: planeRef.filePath,
        producers, parts: [], imports: [],
      }, { success: true, preview: statement });
    } catch (err: any) {
      res.status(500).json({ success: false, reason: err?.message ?? String(err) });
    }
    return;
  }
  const filePath = fluidCadServer.getCurrentFileName();
  if (!filePath) {
    res.status(404).json({ success: false, reason: 'No rendered scene' });
    return;
  }
  const statement = `sketch(${plane ? `'${plane}', ` : ''}() => {\n\n})`;
  if (preview === true) {
    res.json({ success: true, preview: statement, args: '' });
    return;
  }
  const activePart = activePartFor(filePath);
  await dispatcher.dispatch(
    res,
    {
      feature: 'sketch', sketchPlane: plane, filePath, producers: [], parts: [], imports: [],
      ...(activePart ? { activePart } : {}),
    },
    { success: true, preview: statement },
  );
}
