import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';
import {
  applyFeatureEdit, extractNumericParams, makeProducerNamer, renderExtrudeStatement, resolveParamValues,
  type ExtrudeEditOptions,
} from '../apply-feature-edit.ts';

const MAX_ENTITIES = 32;

type RawPick = { shapeId?: unknown; sub?: { type?: unknown; index?: unknown } };

type Pick = { shapeId: string; sub: { type: 'edge' | 'face'; index: number } };

function validatePick(raw: RawPick | undefined): Pick | null {
  const validType = raw?.sub?.type === 'edge' || raw?.sub?.type === 'face';
  const validIndex = Number.isInteger(raw?.sub?.index) && (raw!.sub!.index as number) >= 0;
  if (!raw || typeof raw.shapeId !== 'string' || !raw.shapeId || !validType || !validIndex) {
    return null;
  }
  return {
    shapeId: raw.shapeId,
    sub: { type: raw.sub!.type as 'edge' | 'face', index: raw.sub!.index as number },
  };
}

function validatePicks(entities: unknown): Pick[] | null {
  if (!Array.isArray(entities) || entities.length < 1 || entities.length > MAX_ENTITIES) {
    return null;
  }
  const picks = [];
  for (const raw of entities as RawPick[]) {
    const pick = validatePick(raw);
    if (!pick) {
      return null;
    }
    picks.push(pick);
  }
  return picks;
}

/**
 * The extrude request's shape. No pick selection: the profile is a sketch,
 * addressed by the source location the scene render reported for it —
 * `active` consumes it implicitly, `bound` binds it to a variable.
 */
type ExtrudeRequest = {
  op: 'add' | 'remove' | 'new';
  distance: number | null;
  thin: [number] | [number, number] | null;
  profile: { mode: 'active' | 'bound'; filePath: string; line: number; column: number };
};

function validateExtrude(body: any): ExtrudeRequest | { error: string } {
  const { op, distance, thin, profile } = body ?? {};
  if (op !== 'add' && op !== 'remove' && op !== 'new') {
    return { error: 'op must be "add", "remove" or "new"' };
  }
  if (distance === null) {
    if (op !== 'remove') {
      return { error: 'distance may be null (through-all) only for a remove' };
    }
  } else if (typeof distance !== 'number' || !Number.isFinite(distance) || distance === 0) {
    return { error: 'distance must be a nonzero number (negative extrudes the other way)' };
  }
  let thinOffsets: [number] | [number, number] | null = null;
  if (thin !== undefined && thin !== null) {
    const valid = Array.isArray(thin) && thin.length >= 1 && thin.length <= 2
      && thin.every((t: unknown) => typeof t === 'number' && Number.isFinite(t) && t > 0);
    if (!valid) {
      return { error: 'thin must be one or two positive offsets' };
    }
    thinOffsets = thin.length === 1 ? [thin[0]] : [thin[0], thin[1]];
  }
  const mode = profile?.mode;
  const validProfile = (mode === 'active' || mode === 'bound')
    && typeof profile.filePath === 'string' && profile.filePath.length > 0
    && Number.isInteger(profile.line) && profile.line >= 1;
  if (!validProfile) {
    return { error: 'profile must be {mode: "active"|"bound", filePath, line} of the sketch' };
  }
  return {
    op, distance, thin: thinOffsets,
    profile: {
      mode, filePath: profile.filePath, line: profile.line,
      column: Number.isInteger(profile.column) && profile.column >= 0 ? profile.column : 0,
    },
  };
}

/** Tangent chains: `{seed, members}` groups; absent/empty is fine. */
function validateChains(chains: unknown): { seed: Pick; members: Pick[] }[] | null {
  if (chains === undefined || chains === null) {
    return [];
  }
  if (!Array.isArray(chains) || chains.length > MAX_ENTITIES) {
    return null;
  }
  const result = [];
  for (const raw of chains as { seed?: RawPick; members?: unknown }[]) {
    const seed = validatePick(raw?.seed);
    const members = validatePicks(raw?.members);
    if (!seed || !members) {
      return null;
    }
    result.push({ seed, members });
  }
  return result;
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
  // `preview: true` runs synthesis only (backs the expression field);
  // `selectorOverride` replaces the argument list with user-edited text.
  router.post('/apply-feature', async (req, res) => {
    const { feature, value, preview, selectorOverride } = req.body ?? {};

    // Extrude takes no pick selection — its profile is a sketch statement.
    // The transform re-verifies that the line holds a sketch() call.
    if (feature === 'extrude') {
      const request = validateExtrude(req.body);
      if ('error' in request) {
        res.status(400).json({ error: request.error });
        return;
      }
      try {
        const options: ExtrudeEditOptions = {
          op: request.op,
          distance: request.distance,
          thin: request.thin,
          profile: request.profile.mode === 'bound' ? 'bound' : 'implicit',
        };
        // Truthful preview name for a bound profile: the same resolution the
        // transform runs (reused const, collision-suffixed hint).
        let profileVar: string | null = null;
        if (request.profile.mode === 'bound') {
          const code = fluidCadServer.getCurrentCode();
          if (code) {
            const namer = await makeProducerNamer(code);
            profileVar = namer([{ line: request.profile.line, nameHint: 's', featureType: 'sketch' }])[0];
          }
        }
        const statement = renderExtrudeStatement(options, profileVar);
        if (preview === true) {
          res.json({ success: true, preview: statement });
          return;
        }
        sendToExtension({
          type: 'apply-feature-edit',
          spec: {
            feature: 'extrude',
            extrude: options,
            filePath: request.profile.filePath,
            producers: [{
              line: request.profile.line,
              column: request.profile.column,
              featureType: 'sketch',
              nameHint: 's',
              bind: request.profile.mode === 'bound',
            }],
            parts: [],
            imports: [],
          },
        });
        res.json({ success: true, preview: statement });
      } catch (err: any) {
        res.status(500).json({ success: false, reason: err?.message ?? String(err) });
      }
      return;
    }

    const picks = validatePicks(req.body?.entities);
    if (!picks) {
      res.status(400).json({ error: `entities must be 1-${MAX_ENTITIES} picks of {shapeId, sub:{type, index}}` });
      return;
    }
    const chains = validateChains(req.body?.chains);
    if (!chains) {
      res.status(400).json({ error: 'chains must be {seed, members} pick groups' });
      return;
    }
    if (feature !== 'fillet' && feature !== 'chamfer' && feature !== 'shell' && feature !== 'sketch') {
      res.status(400).json({ error: 'feature must be "fillet", "chamfer", "shell", "sketch" or "extrude"' });
      return;
    }
    // Per-feature numeric parameter: fillet/chamfer need a positive radius or
    // distance; shell needs a nonzero thickness (negative is the idiom —
    // shell(-2, …) hollows inward); sketch has no numeric parameter at all.
    if (feature === 'shell') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) {
        res.status(400).json({ error: 'value must be a nonzero number (negative hollows inward)' });
        return;
      }
    } else if (feature !== 'sketch') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        res.status(400).json({ error: 'value must be a positive number' });
        return;
      }
    }
    if (selectorOverride !== undefined
      && (typeof selectorOverride !== 'string' || selectorOverride.trim().length === 0 || selectorOverride.length > 500)) {
      res.status(400).json({ error: 'selectorOverride must be a non-empty string (max 500 chars)' });
      return;
    }

    try {
      // Source-derived context from the live buffer: the namer keeps
      // previewed variable names truthful to the transform (reused const
      // names, collisions suffixed past file identifiers); params let
      // synthesized dimension constants render as the user's own variables.
      // Without a buffer, synthesis falls back to hints and bare numbers.
      const code = fluidCadServer.getCurrentCode();
      const options = code
        ? {
          namer: await makeProducerNamer(code),
          params: resolveParamValues(
            await extractNumericParams(code),
            fluidCadServer.getParamDefinitions(),
          ),
        }
        : undefined;
      const synthesis = fluidCadServer.synthesizeApplyFeature(
        picks, feature, feature === 'sketch' ? undefined : value, chains, options,
      );
      if (!synthesis) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return;
      }
      if (!synthesis.ok) {
        res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
        return;
      }
      if (preview === true) {
        res.json({
          success: true,
          preview: synthesis.preview,
          args: synthesis.args,
          alternatives: synthesis.alternatives,
        });
        return;
      }
      const spec = typeof selectorOverride === 'string' && selectorOverride.trim() !== synthesis.args
        ? { ...synthesis.spec, rawArgs: selectorOverride.trim() }
        : synthesis.spec;
      sendToExtension({ type: 'apply-feature-edit', spec });
      res.json({ success: true, preview: synthesis.preview });
    } catch (err: any) {
      res.status(500).json({ success: false, reason: err?.message ?? String(err) });
    }
  });

  // Expand a picked edge/face to its tangent chain on the owning solid —
  // the "Select with tangents" gesture. Read-only against the last render.
  router.post('/selection/expand-tangents', (req, res) => {
    const pick = validatePick(req.body?.entity);
    if (!pick) {
      res.status(400).json({ error: 'entity must be a {shapeId, sub:{type, index}} pick' });
      return;
    }
    try {
      const result = fluidCadServer.expandTangentChain(pick);
      if (!result) {
        res.status(404).json({ error: 'No rendered scene' });
        return;
      }
      if (result.ok === false) {
        res.status(422).json({ error: result.reason });
        return;
      }
      res.json({ members: result.members });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // Expand a picked edge/face to its whole classified bucket — the
  // double-click gesture. Read-only against the last render.
  router.post('/selection/expand-bucket', (req, res) => {
    const pick = validatePick(req.body?.entity);
    if (!pick) {
      res.status(400).json({ error: 'entity must be a {shapeId, sub:{type, index}} pick' });
      return;
    }
    try {
      const result = fluidCadServer.expandBucket(pick);
      if (!result) {
        res.status(404).json({ error: 'No rendered scene' });
        return;
      }
      if (result.ok === false) {
        res.status(422).json({ error: result.reason });
        return;
      }
      res.json({ members: result.members });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
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
