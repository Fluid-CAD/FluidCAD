import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';
import { applyFeatureEdit } from '../apply-feature-edit.ts';

const MAX_ENTITIES = 32;

type RawPick = { shapeId?: unknown; sub?: { type?: unknown; index?: unknown } };

function validatePicks(entities: unknown): { shapeId: string; sub: { type: 'edge' | 'face'; index: number } }[] | null {
  if (!Array.isArray(entities) || entities.length < 1 || entities.length > MAX_ENTITIES) {
    return null;
  }
  const picks = [];
  for (const raw of entities as RawPick[]) {
    const validType = raw?.sub?.type === 'edge' || raw?.sub?.type === 'face';
    const validIndex = Number.isInteger(raw?.sub?.index) && (raw!.sub!.index as number) >= 0;
    if (!raw || typeof raw.shapeId !== 'string' || !raw.shapeId || !validType || !validIndex) {
      return null;
    }
    picks.push({
      shapeId: raw.shapeId,
      sub: { type: raw.sub!.type as 'edge' | 'face', index: raw.sub!.index as number },
    });
  }
  return picks;
}

export function createApplyFeatureRouter(
  fluidCadServer: FluidCadServer,
  sendToExtension: (msg: any) => void,
): Router {
  const router = Router();

  // Read-only attribution report against the last rendered scene. Backs the
  // pick tooltips/debugging; never touches code.
  router.post('/selection/explain', (req, res) => {
    const picks = validatePicks(req.body?.entities);
    if (!picks) {
      res.status(400).json({ error: `entities must be 1-${MAX_ENTITIES} picks of {shapeId, sub:{type, index}}` });
      return;
    }
    try {
      const result = fluidCadServer.explainSelection(picks);
      if (!result) {
        res.status(404).json({ error: 'No rendered scene' });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // Synthesize the selector expressions for the picked edges and relay the
  // edit spec to the editor extension, which owns the live buffer.
  router.post('/apply-feature', (req, res) => {
    const { feature, value } = req.body ?? {};
    const picks = validatePicks(req.body?.entities);
    if (!picks) {
      res.status(400).json({ error: `entities must be 1-${MAX_ENTITIES} picks of {shapeId, sub:{type, index}}` });
      return;
    }
    if (feature !== 'fillet' && feature !== 'chamfer') {
      res.status(400).json({ error: 'feature must be "fillet" or "chamfer"' });
      return;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      res.status(400).json({ error: 'value must be a positive number' });
      return;
    }

    try {
      const synthesis = fluidCadServer.synthesizeApplyFeature(picks, feature, value);
      if (!synthesis) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return;
      }
      if (!synthesis.ok) {
        res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
        return;
      }
      sendToExtension({ type: 'apply-feature-edit', spec: synthesis.spec });
      res.json({ success: true, preview: synthesis.preview });
    } catch (err: any) {
      res.status(500).json({ success: false, reason: err?.message ?? String(err) });
    }
  });

  // Pure source transform: the extension sends the live buffer plus the edit
  // spec and gets the fully edited text back (same shape as /api/code/*).
  router.post('/code/apply-feature', async (req, res) => {
    const { code, spec } = req.body ?? {};
    if (typeof code !== 'string' || !spec || !Array.isArray(spec.producers) || !Array.isArray(spec.parts)) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await applyFeatureEdit(code, spec);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}
