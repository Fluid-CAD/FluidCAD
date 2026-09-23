// POST /apply-feature, the connector create branch.

import type { Request, Response } from 'express';
import {
  renderConnectorChain,
  validConnectorAnchor,
  validConnectorRotate,
  type ApplyFeatureEditSpec,
} from '../../../apply-feature-edit/index.ts';
import { validatePicks } from '../picks.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// Named connector (part files): the single pick is the connector's source
// face/edge and `name` is the identifier the statement registers. The
// kernel stamps the name and the enclosing part() call site into the
// spec; the transform lands the statement inside that part's callback
// body, before a trailing return.
export async function handleConnector(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, synthesisOptionsForFile, preview, selectorOverride } = ctx;
  const picks = validatePicks(req.body?.entities);
  if (!picks) {
    res.status(400).json({ error: 'entities must be a non-empty array of {shapeId, sub:{type, index}} picks' });
    return;
  }
  const name = req.body?.name;
  if (typeof name !== 'string' || name.length > 64 || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
    res.status(400).json({ error: 'name must be a plain identifier (max 64 chars)' });
    return;
  }
  if (selectorOverride !== undefined
    && (typeof selectorOverride !== 'string' || selectorOverride.trim().length === 0 || selectorOverride.length > 500)) {
    res.status(400).json({ error: 'selectorOverride must be a non-empty string (max 500 chars)' });
    return;
  }
  const anchor = req.body?.anchor;
  if (!validConnectorAnchor(anchor)) {
    res.status(400).json({ error: "anchor must be {kind: 'center'|'start'|'end'} or {kind: 'offset', mode: 'relative'|'absolute', value}" });
    return;
  }
  const rotate = req.body?.rotate;
  if (!validConnectorRotate(rotate)) {
    res.status(400).json({ error: "rotate must be { axis: 'x'|'y'|'z', angle } with a finite angle in degrees" });
    return;
  }
  const frameOffset = req.body?.offset;
  if (frameOffset !== undefined
    && !(Array.isArray(frameOffset) && frameOffset.length === 3 && frameOffset.every((v: unknown) => Number.isFinite(v)))) {
    res.status(400).json({ error: 'offset must be [x, y, z] finite numbers' });
    return;
  }
  try {
    const connectorOptions = {
      anchor,
      rotate,
      offset: frameOffset,
    };
    // Two-pass: a bare synthesis learns which file the statement lands
    // in (the picked producers' file — the PART file under an assembly
    // render), then the real pass runs with namer/params built over
    // that file's code so binding names and linked constants are the
    // target file's, not the open buffer's.
    const probe = fluidCadServer.synthesizeApplyFeature(
      picks, 'connector', name, [], { connector: connectorOptions },
    );
    if (!probe) {
      res.status(404).json({ success: false, reason: 'No rendered scene' });
      return;
    }
    if (!probe.ok) {
      res.status(422).json({ success: false, reason: probe.reason, pick: probe.pick });
      return;
    }
    const fileOptions = await synthesisOptionsForFile(probe.spec.filePath);
    const synthesis = fileOptions
      ? fluidCadServer.synthesizeApplyFeature(
        picks, 'connector', name, [], { ...fileOptions, connector: connectorOptions },
      )
      : probe;
    if (!synthesis || !synthesis.ok) {
      res.status(422).json({
        success: false,
        reason: synthesis && !synthesis.ok ? synthesis.reason : 'No rendered scene',
      });
      return;
    }
    // Composed here rather than taken from `synthesis.preview` so the
    // previewed text is exactly what the transform writes (the args
    // already carry the anchor suffix; the chain matches the transform's).
    const statementPreview = `connector('${name}', ${synthesis.args})${renderConnectorChain({ rotate, offset: frameOffset })}`;
    if (preview === true) {
      res.json({
        success: true,
        preview: statementPreview,
        args: synthesis.args,
        alternatives: synthesis.alternatives,
      });
      return;
    }
    let spec: ApplyFeatureEditSpec = synthesis.spec;
    if (typeof selectorOverride === 'string' && selectorOverride.trim() !== synthesis.args) {
      spec = { ...spec, rawArgs: selectorOverride.trim() };
    }
    await dispatcher.dispatch(res, spec, { success: true, preview: statementPreview });
  } catch (err: any) {
    res.status(500).json({ success: false, reason: err?.message ?? String(err) });
  }
}
