// Code-level endpoints: new part bodies and the editor-host apply-feature ack round trip.

import type { Router } from 'express';
import { applyFeatureEdit } from '../../../apply-feature-edit/index.ts';
import { detectKind } from '../../../file-kind.ts';
import type { ApplyFeatureServices } from '../context.ts';

export function registerCodeEndpoints(router: Router, services: ApplyFeatureServices): void {
  const { fluidCadServer, dispatcher } = services;

  // The Part tool: append an empty `part('Part N', () => {})` statement to
  // the current part file (the transform allocates the name past every part
  // already there). Rides the shared edit dispatcher like every other
  // statement write; the newPart side-channel supersedes the placeholder
  // feature field.
  router.post('/part/new', async (req, res) => {
    const name = req.body?.name;
    if (name !== undefined && (typeof name !== 'string' || name.length === 0)) {
      res.status(400).json({ error: 'name must be a non-empty string' });
      return;
    }
    const filePath = fluidCadServer.getCurrentFileName();
    if (!filePath) {
      res.status(404).json({ success: false, reason: 'No rendered scene' });
      return;
    }
    if (detectKind(filePath) === 'assembly') {
      res.status(422).json({ success: false, reason: 'part() builds in a part file — assemblies compose parts via insert()' });
      return;
    }
    await dispatcher.dispatch(res, {
      feature: 'sketch',
      filePath,
      producers: [],
      parts: [],
      imports: [],
      newPart: name !== undefined ? { name } : {},
    }, { success: true });
  });

  // Pure source transform: the extension sends the live buffer plus the edit
  // spec and gets the fully edited text back (same shape as /api/code/*).
  // A spec carrying an `editId` is the round-trip of a dispatcher send — its
  // outcome settles the original /apply-feature request still waiting on the
  // ack.
  router.post('/code/apply-feature', async (req, res) => {
    const { code, spec } = req.body ?? {};
    if (typeof code !== 'string' || !spec || !Array.isArray(spec.producers) || !Array.isArray(spec.parts)) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const { editId, ...editSpec } = spec;
    try {
      const result = await applyFeatureEdit(code, editSpec);
      if (typeof editId === 'string') {
        dispatcher.settle(editId, result.error);
      }
      res.json(result);
    } catch (err: any) {
      const message = err?.message || String(err);
      if (typeof editId === 'string') {
        dispatcher.settle(editId, message);
      }
      res.status(500).json({ error: message });
    }
  });
}
