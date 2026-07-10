import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';
import {
  applyFeatureEdit, extractNumericParams, makeProducerNamer, renderExtrudeStatement, renderLoftStatement,
  renderSelectorPartExpr, renderSweepStatement, resolveParamValues, resolveSketchNames,
  type ApplyFeatureEditSpec, type ExtrudeEditOptions, type LoftEditOptions, type SweepEditOptions,
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

/** A sketch addressed by the source location the scene render reported. */
type SketchLoc = { filePath: string; line: number; column: number };

/** One or two positive `.thin()` offsets; absent means a plain feature. */
function validateThinOffsets(thin: unknown): { offsets: [number] | [number, number] | null } | { error: string } {
  if (thin === undefined || thin === null) {
    return { offsets: null };
  }
  const valid = Array.isArray(thin) && thin.length >= 1 && thin.length <= 2
    && thin.every((t: unknown) => typeof t === 'number' && Number.isFinite(t) && t > 0);
  if (!valid) {
    return { error: 'thin must be one or two positive offsets' };
  }
  return { offsets: thin.length === 1 ? [thin[0]] : [thin[0], thin[1]] };
}

function validateSketchLoc(loc: any): SketchLoc | null {
  const valid = loc && typeof loc.filePath === 'string' && loc.filePath.length > 0
    && Number.isInteger(loc.line) && loc.line >= 1;
  if (!valid) {
    return null;
  }
  return {
    filePath: loc.filePath,
    line: loc.line,
    column: Number.isInteger(loc.column) && loc.column >= 0 ? loc.column : 0,
  };
}

/**
 * The extrude request's shape. No pick selection: the profile is a sketch —
 * `active` consumes it implicitly, `bound` binds it to a variable.
 */
type ExtrudeRequest = {
  op: 'add' | 'remove' | 'new';
  distance: number | null;
  thin: [number] | [number, number] | null;
  profile: { mode: 'active' | 'bound' } & SketchLoc;
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
  const thinResult = validateThinOffsets(thin);
  if ('error' in thinResult) {
    return thinResult;
  }
  const mode = profile?.mode;
  const loc = validateSketchLoc(profile);
  if ((mode !== 'active' && mode !== 'bound') || !loc) {
    return { error: 'profile must be {mode: "active"|"bound", filePath, line} of the sketch' };
  }
  return { op, distance, thin: thinResult.offsets, profile: { mode, ...loc } };
}

/**
 * The sweep request's shape: the profile is a sketch (like extrude); the
 * path is either another sketch or edge picks to synthesize a selector from.
 */
type SweepRequest = {
  op: 'add' | 'remove' | 'new';
  thin: [number] | [number, number] | null;
  profile: { mode: 'active' | 'bound' } & SketchLoc;
  path:
    | ({ kind: 'sketch' } & SketchLoc)
    | { kind: 'edges'; picks: Pick[]; chains: { seed: Pick; members: Pick[] }[] };
};

function validateSweep(body: any): SweepRequest | { error: string } {
  const { op, thin, profile, path } = body ?? {};
  if (op !== 'add' && op !== 'remove' && op !== 'new') {
    return { error: 'op must be "add", "remove" or "new"' };
  }
  const thinResult = validateThinOffsets(thin);
  if ('error' in thinResult) {
    return thinResult;
  }
  const mode = profile?.mode;
  const profileLoc = validateSketchLoc(profile);
  if ((mode !== 'active' && mode !== 'bound') || !profileLoc) {
    return { error: 'profile must be {mode: "active"|"bound", filePath, line} of the sketch' };
  }
  const base = { op, thin: thinResult.offsets, profile: { mode, ...profileLoc } };
  if (path?.kind === 'sketch') {
    const pathLoc = validateSketchLoc(path);
    if (!pathLoc) {
      return { error: 'a sketch path must carry the sketch {filePath, line}' };
    }
    if (pathLoc.filePath !== profileLoc.filePath) {
      return { error: 'the profile and path sketches live in different files' };
    }
    if (pathLoc.line === profileLoc.line) {
      return { error: 'the profile and path must be different sketches' };
    }
    return { ...base, path: { kind: 'sketch', ...pathLoc } };
  }
  if (path?.kind === 'edges') {
    const picks = validatePicks(path.entities);
    if (!picks) {
      return { error: `path entities must be 1-${MAX_ENTITIES} picks of {shapeId, sub:{type, index}}` };
    }
    const chains = validateChains(path.chains);
    if (!chains) {
      return { error: 'path chains must be {seed, members} pick groups' };
    }
    return { ...base, path: { kind: 'edges', picks, chains } };
  }
  return { error: 'path must be {kind: "sketch", filePath, line} or {kind: "edges", entities}' };
}

/** Ordered loft profile inputs: sketches and picked faces, mixed freely. */
type LoftProfileInput = ({ kind: 'sketch' } & SketchLoc) | { kind: 'face'; pick: Pick };

type LoftRequest = {
  op: 'add' | 'remove' | 'new';
  thin: [number] | [number, number] | null;
  profiles: LoftProfileInput[];
};

const MAX_LOFT_PROFILES = 16;

/**
 * The loft request's shape: two or more ordered profiles, each a sketch or a
 * picked face. Order is the loft's argument order. Duplicates are rejected
 * here — the same sketch or face twice is never a valid loft.
 */
function validateLoft(body: any): LoftRequest | { error: string } {
  const { op, thin, profiles } = body ?? {};
  if (op !== 'add' && op !== 'remove' && op !== 'new') {
    return { error: 'op must be "add", "remove" or "new"' };
  }
  const thinResult = validateThinOffsets(thin);
  if ('error' in thinResult) {
    return thinResult;
  }
  if (!Array.isArray(profiles) || profiles.length < 2 || profiles.length > MAX_LOFT_PROFILES) {
    return { error: `profiles must be 2-${MAX_LOFT_PROFILES} ordered loft profiles` };
  }
  const result: LoftProfileInput[] = [];
  const seen = new Set<string>();
  let filePath: string | null = null;
  for (const raw of profiles) {
    if (raw?.kind === 'sketch') {
      const loc = validateSketchLoc(raw);
      if (!loc) {
        return { error: 'a sketch profile must carry the sketch {filePath, line}' };
      }
      if (filePath !== null && loc.filePath !== filePath) {
        return { error: 'the profile sketches live in different files' };
      }
      filePath = loc.filePath;
      const key = `sketch:${loc.filePath}:${loc.line}`;
      if (seen.has(key)) {
        return { error: 'each profile must be a different sketch' };
      }
      seen.add(key);
      result.push({ kind: 'sketch', ...loc });
    } else if (raw?.kind === 'face') {
      const pick = validatePick(raw.entity);
      if (!pick || pick.sub.type !== 'face') {
        return { error: 'a face profile must carry a {shapeId, sub:{type:"face", index}} pick' };
      }
      const key = `face:${pick.shapeId}:${pick.sub.index}`;
      if (seen.has(key)) {
        return { error: 'the same face was picked twice — each profile must be different' };
      }
      seen.add(key);
      result.push({ kind: 'face', pick });
    } else {
      return { error: 'each profile must be {kind: "sketch", filePath, line} or {kind: "face", entity}' };
    }
  }
  return { op, thin: thinResult.offsets, profiles: result };
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

    // Sweep composes a profile sketch with a path (a second sketch, or edge
    // picks synthesized into a selector) — no shared pick validation applies.
    if (feature === 'sweep') {
      const request = validateSweep(req.body);
      if ('error' in request) {
        res.status(400).json({ error: request.error });
        return;
      }
      try {
        const code = fluidCadServer.getCurrentCode();
        const producers: ApplyFeatureEditSpec['producers'] = [];
        let parts: ApplyFeatureEditSpec['parts'] = [];
        let imports: string[] = [];
        let pathArgs: string | null = null;
        let alternatives: string[] | undefined;

        if (request.path.kind === 'edges') {
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
            request.path.picks, 'sweep', undefined, request.path.chains, options,
          );
          if (!synthesis) {
            res.status(404).json({ success: false, reason: 'No rendered scene' });
            return;
          }
          if (!synthesis.ok) {
            res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
            return;
          }
          // The path argument is ONE SceneObject — a multi-part selection
          // has no single-expression rendering.
          if (synthesis.spec.parts.length !== 1) {
            res.status(422).json({
              success: false,
              reason: 'the picked edges must form a single selection — use "Select with tangents" or pick edges of one feature',
            });
            return;
          }
          if (synthesis.spec.filePath !== request.profile.filePath) {
            res.status(422).json({ success: false, reason: 'the path edges and the profile sketch come from different files' });
            return;
          }
          producers.push(...synthesis.spec.producers);
          parts = synthesis.spec.parts;
          imports = synthesis.spec.imports;
          pathArgs = synthesis.args;
          alternatives = synthesis.alternatives;
        }

        let path: SweepEditOptions['path'];
        if (request.path.kind === 'sketch') {
          producers.push({
            line: request.path.line, column: request.path.column,
            featureType: 'sketch', nameHint: 'p', bind: true,
          });
          path = { kind: 'sketch', producer: producers.length - 1 };
        } else {
          path = { kind: 'selector' };
        }
        // The profile rides the producer list in both modes: bound entries
        // get a variable, the implicit anchor verifies the sketch call and
        // (with a sketch path) locates the insertion scope.
        producers.push({
          line: request.profile.line, column: request.profile.column,
          featureType: 'sketch', nameHint: 's', bind: request.profile.mode === 'bound',
        });
        const profile: SweepEditOptions['profile'] = request.profile.mode === 'bound'
          ? { producer: producers.length - 1 }
          : 'implicit';

        // Truthful preview names for the sketch inputs — one namer pass so
        // collision suffixes stay consistent across both.
        let pathVar: string | null = null;
        let profileVar: string | null = null;
        if (code) {
          const namer = await makeProducerNamer(code);
          const queries: { line: number; nameHint: string; featureType?: string }[] = [];
          if (request.path.kind === 'sketch') {
            queries.push({ line: request.path.line, nameHint: 'p', featureType: 'sketch' });
          }
          if (request.profile.mode === 'bound') {
            queries.push({ line: request.profile.line, nameHint: 's', featureType: 'sketch' });
          }
          const names = queries.length > 0 ? namer(queries) : [];
          let next = 0;
          if (request.path.kind === 'sketch') {
            pathVar = names[next++];
          }
          if (request.profile.mode === 'bound') {
            profileVar = names[next++];
          }
        }

        const options: SweepEditOptions = { op: request.op, thin: request.thin, profile, path };
        const pathExpr = request.path.kind === 'edges' ? pathArgs! : (pathVar ?? 'p');
        const statement = renderSweepStatement(
          options, pathExpr, request.profile.mode === 'bound' ? profileVar ?? 's' : null,
        );
        if (preview === true) {
          res.json({ success: true, preview: statement, args: pathArgs ?? undefined, alternatives });
          return;
        }
        sendToExtension({
          type: 'apply-feature-edit',
          spec: {
            feature: 'sweep',
            sweep: options,
            filePath: request.profile.filePath,
            producers,
            parts,
            imports,
          },
        });
        res.json({ success: true, preview: statement });
      } catch (err: any) {
        res.status(500).json({ success: false, reason: err?.message ?? String(err) });
      }
      return;
    }

    // Loft takes an ordered list of profiles — sketches and picked faces
    // mixed freely. Face picks run synthesis ONE AT A TIME: the kernel groups
    // picks by (producer, bucket), so a batched call would merge same-bucket
    // faces into one part and destroy profile order and arity.
    if (feature === 'loft') {
      const request = validateLoft(req.body);
      if ('error' in request) {
        res.status(400).json({ error: request.error });
        return;
      }
      try {
        const code = fluidCadServer.getCurrentCode();
        // Built on the first face profile — an all-sketch loft never runs
        // synthesis. Only `params` is passed: a namer would only shape
        // synthesis's own preview strings, which this branch discards
        // (profiles are re-rendered from the parts below).
        let synthOptions: { params: { name: string; value: number }[] } | undefined;
        let synthOptionsReady = false;

        const producers: ApplyFeatureEditSpec['producers'] = [];
        const parts: ApplyFeatureEditSpec['parts'] = [];
        const imports = new Set<string>();
        const profiles: LoftEditOptions['profiles'] = [];
        let filePath: string | null = null;

        // Producers merge across the per-pick synthesis calls (and the sketch
        // profiles) by call site; a bind:true entry wins over an anchor.
        const producerIndex = new Map<string, number>();
        const mergeProducer = (producer: ApplyFeatureEditSpec['producers'][number]): number => {
          const key = `${producer.line}:${producer.column}`;
          const existing = producerIndex.get(key);
          if (existing === undefined) {
            producerIndex.set(key, producers.length);
            producers.push(producer);
            return producers.length - 1;
          }
          if (producer.bind && !producers[existing].bind) {
            producers[existing] = producer;
          }
          return existing;
        };

        for (const profile of request.profiles) {
          if (profile.kind === 'sketch') {
            // validateLoft holds sketches to one file; this catches a sketch
            // following a face pick synthesized from a different file.
            if (filePath !== null && profile.filePath !== filePath) {
              res.status(422).json({ success: false, reason: 'the loft profiles come from features in different files' });
              return;
            }
            filePath = profile.filePath;
            profiles.push({
              kind: 'sketch',
              producer: mergeProducer({
                line: profile.line, column: profile.column,
                featureType: 'sketch', nameHint: 's', bind: true,
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
            [profile.pick], 'loft', undefined, [], synthOptions,
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
            res.status(422).json({ success: false, reason: 'a loft profile must be a single face selection' });
            return;
          }
          if (filePath !== null && synthesis.spec.filePath !== filePath) {
            res.status(422).json({ success: false, reason: 'the loft profiles come from features in different files' });
            return;
          }
          filePath = synthesis.spec.filePath;
          const remap = synthesis.spec.producers.map(mergeProducer);
          const part = synthesis.spec.parts[0];
          parts.push({ ...part, producer: part.producer === null ? null : remap[part.producer] });
          for (const symbol of synthesis.spec.imports) {
            imports.add(symbol);
          }
          profiles.push({ kind: 'selector', part: parts.length - 1 });
        }

        // Truthful preview names: one namer pass over the bound producers in
        // spec order — the same allocation walk the transform runs. Unnamed
        // producers fall back to collision-suffixed hints.
        const names: (string | null)[] = producers.map((): null => null);
        if (code) {
          const namer = await makeProducerNamer(code);
          const bound = producers
            .map((producer, index) => ({ producer, index }))
            .filter(entry => entry.producer.bind);
          const resolved = namer(bound.map(({ producer }) => ({
            line: producer.line, nameHint: producer.nameHint, featureType: producer.featureType,
          })));
          bound.forEach((entry, i) => {
            names[entry.index] = resolved[i];
          });
        }
        const used = new Set(names.filter((n): n is string => n !== null));
        const producerVars = producers.map((producer, i) => {
          if (!producer.bind) {
            return null;
          }
          if (names[i]) {
            return names[i];
          }
          const hint = producer.nameHint || 'f';
          let name = hint;
          let suffix = 1;
          while (used.has(name)) {
            suffix++;
            name = `${hint}${suffix}`;
          }
          used.add(name);
          return name;
        });

        const profileExprs = profiles.map(profile => {
          if (profile.kind === 'sketch') {
            return producerVars[profile.producer] ?? 's';
          }
          const part = parts[profile.part];
          return renderSelectorPartExpr(part, part.producer === null ? null : producerVars[part.producer]);
        });

        const options: LoftEditOptions = { op: request.op, thin: request.thin, profiles };
        const statement = renderLoftStatement(options, profileExprs);
        if (preview === true) {
          res.json({ success: true, preview: statement });
          return;
        }
        sendToExtension({
          type: 'apply-feature-edit',
          spec: {
            feature: 'loft',
            loft: options,
            filePath: filePath!,
            producers,
            parts,
            imports: [...imports],
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
      res.status(400).json({ error: 'feature must be "fillet", "chamfer", "shell", "sketch", "extrude", "sweep" or "loft"' });
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

  // Variable names of the sketch statements at the given source lines, for
  // create-dialog labels ("spine — line 3"). Read-only over the live buffer;
  // lines without a bound sketch resolve to null.
  router.post('/sketch-names', async (req, res) => {
    const { lines } = req.body ?? {};
    const valid = Array.isArray(lines) && lines.length <= 64
      && lines.every((l: unknown) => Number.isInteger(l) && (l as number) >= 1);
    if (!valid) {
      res.status(400).json({ error: 'lines must be up to 64 positive integers' });
      return;
    }
    const lineNumbers = lines as number[];
    try {
      const code = fluidCadServer.getCurrentCode();
      if (!code) {
        res.json({ names: lineNumbers.map((): null => null) });
        return;
      }
      res.json({ names: await resolveSketchNames(code, lineNumbers) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
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
