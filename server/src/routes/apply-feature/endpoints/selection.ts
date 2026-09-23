// Read-only selection and statement endpoints: attribution, sketch names, feature sources, connector anchors and statement parsing.

import type { Router } from 'express';
import type { SelectionBoundary } from '../../../fluidcad-server.ts';
import {
  parseFeatureStatement,
  parseOffsetTargetDescriptors,
  resolveEditedStatementLine,
  resolveSketchNames,
} from '../../../apply-feature-edit/index.ts';
import { normalizePath } from '../../../normalize-path.ts';
import { validateSketchLoc } from '../locations.ts';
import { validateBoundary, validatePick, validatePicks, type Pick } from '../picks.ts';
import type { ApplyFeatureServices } from '../context.ts';

export function registerSelectionEndpoints(router: Router, services: ApplyFeatureServices): void {
  const { fluidCadServer, synthesisOptionsForFile } = services;

  // Read-only attribution report against the last rendered scene. Backs the
  // pick tooltips/debugging; never touches code.
  router.post('/selection/explain', (req, res) => {
    const picks = validatePicks(req.body?.entities);
    if (!picks) {
      res.status(400).json({ error: 'entities must be a non-empty array of {shapeId, sub:{type, index}} picks' });
      return;
    }
    const before = validateBoundary(req.body?.before);
    if (before === null) {
      res.status(400).json({ error: 'before must be {index, type, line, column}' });
      return;
    }
    try {
      const result = fluidCadServer.explainSelection(picks, before);
      if (!result) {
        res.status(404).json({ error: 'No rendered scene' });
        return;
      }
      if (result.ok === false) {
        res.status(422).json({ error: result.reason });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // Read the feature statement at a source line into its dialog-editable
  // options — the read half of the timeline double-click → edit-dialog round
  // trip. Read-only over the live buffer.
  router.post('/feature/parse', async (req, res) => {
    const { line, filePath } = req.body ?? {};
    if (!Number.isInteger(line) || line < 1) {
      res.status(400).json({ error: 'line must be a positive integer' });
      return;
    }
    try {
      const code = fluidCadServer.getCurrentCode();
      if (!code) {
        res.status(404).json({ error: 'No live code buffer' });
        return;
      }
      const currentFile = fluidCadServer.getCurrentFileName();
      if (typeof filePath === 'string' && filePath && currentFile
        && normalizePath(filePath) !== normalizePath(currentFile)) {
        res.status(422).json({ error: 'that feature lives in a different file than the one being edited' });
        return;
      }
      const result = await parseFeatureStatement(code, line);
      if (result.ok === false) {
        res.status(422).json({ error: result.reason });
        return;
      }
      res.json({ ok: true, parsed: result.parsed, statement: result.statement });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // Variable names of the sketch (or plane) statements at the given source
  // lines, for create-dialog labels ("spine — line 3"). Read-only over the
  // live buffer; lines without a bound statement resolve to null.
  router.post('/sketch-names', async (req, res) => {
    const { lines, callee } = req.body ?? {};
    const valid = Array.isArray(lines) && lines.length <= 64
      && lines.every((l: unknown) => Number.isInteger(l) && (l as number) >= 1);
    if (!valid) {
      res.status(400).json({ error: 'lines must be up to 64 positive integers' });
      return;
    }
    if (callee !== undefined && callee !== 'sketch' && callee !== 'plane' && callee !== 'axis'
      && callee !== 'helix' && callee !== 'offset') {
      res.status(400).json({ error: 'callee must be "sketch", "plane", "axis", "helix" or "offset"' });
      return;
    }
    const lineNumbers = lines as number[];
    try {
      const code = fluidCadServer.getCurrentCode();
      if (!code) {
        res.json({ names: lineNumbers.map((): null => null) });
        return;
      }
      res.json({ names: await resolveSketchNames(code, lineNumbers, callee ?? 'sketch') });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // The single-pick selection queries share a shape: validate the pick (and
  // the optional edit-mode boundary), run a read-only query against the last
  // render, surface not-ok reasons as 422.
  const selectionQueryRoute = (
    path: string,
    run: (pick: Pick, before?: SelectionBoundary) => any,
    project: (result: any) => unknown,
  ): void => {
    router.post(path, (req, res) => {
      const pick = validatePick(req.body?.entity);
      if (!pick) {
        res.status(400).json({ error: 'entity must be a {shapeId, sub:{type, index}} pick' });
        return;
      }
      const before = validateBoundary(req.body?.before);
      if (before === null) {
        res.status(400).json({ error: 'before must be {index, type, line, column}' });
        return;
      }
      try {
        const result = run(pick, before);
        if (!result) {
          res.status(404).json({ error: 'No rendered scene' });
          return;
        }
        if (result.ok === false) {
          res.status(422).json({ error: result.reason });
          return;
        }
        res.json(project(result));
      } catch (err: any) {
        res.status(500).json({ error: err?.message ?? String(err) });
      }
    });
  };

  // Current target edges of the 2D statement (offset, slot, fillet) being
  // edited, resolved for edit-dialog seeding. The edit's pause-before means
  // the statement's own object is absent from the paused scene, so the
  // targets re-resolve from the statement's own argument forms against the
  // active sketch — after healing the line the pause's breakpoint shifted.
  router.post('/sketch/feature-sources', async (req, res) => {
    const edit = validateSketchLoc(req.body?.edit);
    if (!edit) {
      res.status(400).json({ error: 'edit must be the {filePath, line, column} of the statement' });
      return;
    }
    const expected = req.body?.expectedStatement;
    if (expected !== undefined && (typeof expected !== 'string' || expected.length === 0 || expected.length > 4000)) {
      res.status(400).json({ error: 'expectedStatement must be the statement text from /api/feature/parse' });
      return;
    }
    try {
      const code = fluidCadServer.getCurrentCode();
      if (!code) {
        res.status(404).json({ error: 'No rendered scene' });
        return;
      }
      const line = await resolveEditedStatementLine(code, edit.line, expected);
      const parsed = await parseOffsetTargetDescriptors(code, line);
      if (parsed.ok === false) {
        res.status(422).json({ error: parsed.reason });
        return;
      }
      if (parsed.descriptors.length === 0) {
        // A whole-sketch offset (or a plain anchored text) targets nothing
        // nameable — nothing to seed.
        res.json({ ok: true, shapeIds: [] });
        return;
      }
      const result = fluidCadServer.resolveSketchStatementTargets(parsed.descriptors);
      if (!result) {
        res.status(404).json({ error: 'No rendered scene' });
        return;
      }
      if (result.ok === false) {
        res.status(422).json({ error: result.reason });
        return;
      }
      res.json({ ok: true, shapeIds: result.shapeIds });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // Current sources of the statement being edited, resolved for edit-dialog
  // seeding: sketch inputs by call site, selection inputs as entities on the
  // pre-statement solids (what a rollback to just before it displays).
  router.post('/feature/sources', (req, res) => {
    const before = validateBoundary(req.body?.before);
    if (!before) {
      res.status(400).json({ error: 'before must be {index, type, line, column}' });
      return;
    }
    try {
      const result = fluidCadServer.featureSources(before);
      if (!result) {
        res.status(404).json({ error: 'No rendered scene' });
        return;
      }
      if (result.ok === false) {
        res.status(422).json({ error: result.reason });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // Expand a picked edge/face to its tangent chain on the owning solid —
  // the "Select with tangents" gesture.
  selectionQueryRoute('/selection/expand-tangents',
    (pick, before) => fluidCadServer.expandTangentChain(pick, before),
    result => ({ members: result.members }));

  // Expand a picked edge/face to its whole classified bucket — the
  // double-click gesture.
  selectionQueryRoute('/selection/expand-bucket',
    (pick, before) => fluidCadServer.expandBucket(pick, before),
    result => ({ members: result.members }));

  // Every multi-select group a pick can expand to (the right-click menu):
  // tangent chain, classified bucket, same-type and equal-measure edges.
  selectionQueryRoute('/selection/groups',
    (pick, before) => fluidCadServer.listSelectionGroups(pick, before),
    result => ({ groups: result.groups }));

  // Hover-time connector anchor suggestions: the anchors a picked face/edge
  // supports (face center; edge center/start/end) with exact frames, the
  // synthesized source expression, and a name unique within the part. The
  // connector tool renders the suggestion triad from these frames and the
  // apply branch above re-synthesizes on commit.
  router.post('/selection/connector-anchors', async (req, res) => {
    const pick = validatePick(req.body?.entity);
    if (!pick) {
      res.status(400).json({ error: 'entity must be a {shapeId, sub:{type, index}} pick' });
      return;
    }
    try {
      // Two-pass, mirroring the connector create branch: the bare pass
      // learns the statement's target file; the real pass builds
      // namer/params over that file so the suggested args match what the
      // commit writes.
      const probe = fluidCadServer.suggestConnectorAnchors(pick);
      if (!probe) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return;
      }
      if (probe.ok === false) {
        res.json({ success: false, reason: probe.reason });
        return;
      }
      const fileOptions = await synthesisOptionsForFile(probe.filePath);
      const result = fileOptions
        ? fluidCadServer.suggestConnectorAnchors(pick, fileOptions) ?? probe
        : probe;
      if (result.ok === false) {
        res.json({ success: false, reason: result.reason });
        return;
      }
      res.json({
        success: true,
        defaultName: result.defaultName,
        args: result.args,
        filePath: result.filePath,
        anchors: result.anchors,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, reason: err?.message ?? String(err) });
    }
  });
}
