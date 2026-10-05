// POST /apply-feature, the expose create branch.

import type { Request, Response } from 'express';
import type { ApplyFeatureEditSpec } from '../../../apply-feature-edit/index.ts';
import { validatePicks } from '../picks.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// Named exposure (part files): the single pick is the exposure's source
// face/edge and `name` is the identifier the statement registers under
// `def.features.<name>`. Same rails as the connector arm — the kernel
// stamps the name and the enclosing part() call site into the spec, the
// transform lands the statement inside that part's callback body — minus
// the frame adjustments (an exposure has no anchor/rotate/offset).
export async function handleExpose(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
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
  try {
    // Two-pass, like the connector arm: a bare synthesis learns which
    // file the statement lands in (the picked producers' file — the PART
    // file under an assembly render), then the real pass runs with
    // namer/params built over that file's code.
    const probe = fluidCadServer.synthesizeApplyFeature(picks, 'expose', name, []);
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
      ? fluidCadServer.synthesizeApplyFeature(picks, 'expose', name, [], fileOptions)
      : probe;
    if (!synthesis || !synthesis.ok) {
      res.status(422).json({
        success: false,
        reason: synthesis && !synthesis.ok ? synthesis.reason : 'No rendered scene',
      });
      return;
    }
    // Composed here rather than taken from `synthesis.preview` so the
    // previewed text is exactly what the transform writes.
    const statementPreview = `expose('${name}', ${synthesis.args})`;
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
