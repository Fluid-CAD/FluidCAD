import { Router } from 'express';
import { basename } from 'path';
import { readFile } from 'fs/promises';
import type { FluidCadServer } from '../fluidcad-server.ts';
import type { FeatureEditDispatcher } from '../edit-dispatch.ts';
import { parseFeatureStatement, type ApplyFeatureEditSpec } from '../apply-feature-edit.ts';
import {
  ASSEMBLY_MATE_TYPES,
  resolveExportKey,
  type AssemblyMateOptions,
  type AssemblyMatePayload,
  type AssemblyMateType,
  type MateConnectorRef,
  type MateFrameRef,
} from '../assembly-mate-edit.ts';
import { allocateExposeName, makeSynthesisOptionsForFile } from './apply-feature.ts';
import { normalizePath } from '../normalize-path.ts';
import { detectKind } from '../file-kind.ts';

/**
 * One occurrence level of a nested pick's export chain, as the dialog wires
 * it: `keys` when the sub-assembly already exports the next handle (the key
 * path within its return object), `createFrom` when it doesn't — the handle's
 * `insert()` address in its own file, which the route turns into an
 * `assemblyExport` edit (and thereby a key) before writing the mate.
 */
export type MateViaEntryBody =
  | { keys: string[] }
  | { createFrom: { filePath: string; insertLine: number } };

/** The wire form of a connector side: MateConnectorRef with unresolved levels. */
export type MateConnectorSideBody = {
  instanceLine: number;
  connectorName: string;
  viaParts?: MateViaEntryBody[];
};

function isViaEntry(v: unknown): v is MateViaEntryBody {
  if (v === null || typeof v !== 'object') {
    return false;
  }
  const o = v as any;
  if (Array.isArray(o.keys)) {
    return o.createFrom === undefined && o.keys.every((k: unknown) => typeof k === 'string' && k.length > 0);
  }
  return o.keys === undefined
    && o.createFrom !== null && typeof o.createFrom === 'object'
    && typeof o.createFrom.filePath === 'string' && o.createFrom.filePath.length > 0
    && Number.isInteger(o.createFrom.insertLine) && o.createFrom.insertLine >= 1;
}

function isConnectorRef(v: unknown): v is MateConnectorSideBody {
  return v !== null && typeof v === 'object'
    && Number.isInteger((v as any).instanceLine) && (v as any).instanceLine >= 1
    && typeof (v as any).connectorName === 'string' && (v as any).connectorName.length > 0
    && ((v as any).viaParts === undefined
      || (Array.isArray((v as any).viaParts) && (v as any).viaParts.every(isViaEntry)));
}

function isFrameRef(v: unknown): v is MateFrameRef {
  return v !== null && typeof v === 'object'
    && Number.isInteger((v as any).connectorLine) && (v as any).connectorLine >= 1
    && typeof (v as any).connectorName === 'string';
}

type Pick = { shapeId: string; sub: { type: 'edge' | 'face'; index: number } };

function isSidePick(v: unknown): v is Pick {
  const p = v as Pick;
  return v !== null && typeof v === 'object'
    && typeof p.shapeId === 'string' && p.shapeId.length > 0
    && p.sub !== null && typeof p.sub === 'object'
    && (p.sub.type === 'face' || p.sub.type === 'edge')
    && Number.isInteger(p.sub.index) && p.sub.index >= 0;
}

/**
 * One tangent side as the dialog stages it: the instance address plus
 * EITHER the matched exposure's name (no donor edit needed) or the raw
 * pick the route find-or-creates an exposure from at apply time.
 */
export type MateGeometrySideBody = {
  instanceLine: number;
  exposeName?: string;
  pick?: Pick;
};

function isGeometrySide(v: unknown): v is MateGeometrySideBody {
  if (v === null || typeof v !== 'object') {
    return false;
  }
  const o = v as any;
  if (!Number.isInteger(o.instanceLine) || o.instanceLine < 1) {
    return false;
  }
  const named = typeof o.exposeName === 'string' && o.exposeName.length > 0;
  const picked = isSidePick(o.pick);
  return (named || picked)
    && (o.exposeName === undefined || (typeof o.exposeName === 'string' && o.exposeName.length > 0))
    && (o.pick === undefined || picked);
}

function isPair(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n));
}

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
}

function isMateOptions(v: unknown): v is AssemblyMateOptions {
  if (v === undefined) {
    return true;
  }
  if (v === null || typeof v !== 'object') {
    return false;
  }
  const o = v as any;
  return (o.flip === undefined || typeof o.flip === 'boolean')
    && (o.rotate === undefined || (typeof o.rotate === 'number' && Number.isFinite(o.rotate)))
    && (o.offset === undefined || o.offset === null || isVec3(o.offset))
    && (o.limits === undefined || o.limits === null || isPair(o.limits))
    && (o.propagate === undefined || typeof o.propagate === 'boolean');
}

/**
 * The wire payload: connector sides for the lower pairs (either side may
 * instead be an assembly-connector ref, never both), geometry sides for tangent.
 */
export type MatePayloadBody = {
  type: AssemblyMateType;
  connectorA?: MateConnectorSideBody;
  connectorB?: MateConnectorSideBody;
  geometryA?: MateGeometrySideBody;
  geometryB?: MateGeometrySideBody;
  frameA?: MateFrameRef;
  frameB?: MateFrameRef;
  options?: AssemblyMateOptions;
};

function isMatePayload(v: unknown): v is MatePayloadBody {
  if (v === null || typeof v !== 'object') {
    return false;
  }
  const o = v as any;
  if (!ASSEMBLY_MATE_TYPES.includes(o.type) || !isMateOptions(o.options)) {
    return false;
  }
  if (o.type === 'tangent') {
    return isGeometrySide(o.geometryA) && isGeometrySide(o.geometryB)
      && o.connectorA === undefined && o.connectorB === undefined
      && o.frameA === undefined && o.frameB === undefined;
  }
  // Each side is exactly one of connector-ref or frame-ref; at least one
  // side must be a connector (validateMatePayload words the refusal).
  const sideOk = (conn: unknown, frame: unknown) =>
    (isConnectorRef(conn) && frame === undefined)
    || (conn === undefined && isFrameRef(frame));
  return sideOk(o.connectorA, o.frameA) && sideOk(o.connectorB, o.frameB)
    && (isConnectorRef(o.connectorA) || isConnectorRef(o.connectorB))
    && o.geometryA === undefined && o.geometryB === undefined;
}

/**
 * The mate dialog's commit endpoint: write a fresh `mate()` statement (create)
 * or re-render an existing one in place (edit), through the shared edit
 * dispatcher — preflight refusals (unresolvable insert bindings, option/type
 * conflicts) answer 422 before the editor is touched; the host ack settles
 * the response.
 */
export function createAssemblyMateRouter(
  fluidCadServer: FluidCadServer,
  dispatcher: FeatureEditDispatcher,
): Router {
  const router = Router();
  const synthesisOptionsForFile = makeSynthesisOptionsForFile(fluidCadServer);

  /**
   * Tangent side resolution (17-mate-tangent §7.2): a side that matched an
   * existing exposure at pick time just references it; a side carrying a
   * raw pick find-or-creates one — donor edits in the CURRENT file fold
   * into the mate transform atomically (`exposeCreates`), donor edits in
   * other files are dispatched sequentially before the mate lands. A
   * mid-sequence failure leaves orphan expose() statements — benign
   * (find-or-create is idempotent; an unused exposure is inert), but the
   * error names what was and wasn't written.
   */
  const prepareTangentSides = async (
    currentFile: string,
    sides: [MateGeometrySideBody, MateGeometrySideBody],
  ): Promise<
    | { resolved: { instanceLine: number; exposeName: string }[]; exposeCreates: ApplyFeatureEditSpec[]; crossFileCreates: { spec: ApplyFeatureEditSpec; donorFile: string; name: string }[] }
    | { status: number; body: unknown }
  > => {
    const resolved: { instanceLine: number; exposeName: string }[] = [];
    const exposeCreates: ApplyFeatureEditSpec[] = [];
    const crossFileCreates: { spec: ApplyFeatureEditSpec; donorFile: string; name: string }[] = [];
    // Names allocated in this request, per donor part — two fresh picks on
    // one donor must not both claim `g1`.
    const allocated = new Map<string, string[]>();
    for (const side of sides) {
      if (side.exposeName) {
        resolved.push({ instanceLine: side.instanceLine, exposeName: side.exposeName });
        continue;
      }
      const pick = side.pick!;
      const resolution = fluidCadServer.resolveContactPick?.(pick);
      if (!resolution) {
        return { status: 404, body: { success: false, reason: 'No rendered scene' } };
      }
      if (resolution.ok === false) {
        return { status: 422, body: { success: false, reason: resolution.reason } };
      }
      if (!resolution.donor) {
        return {
          status: 422,
          body: { success: false, reason: 'the picked geometry lies outside any part() — tangent mates reference part-owned geometry' },
        };
      }
      if (resolution.seed === null) {
        return {
          status: 422,
          body: {
            success: false,
            reason: "tangent between these surface types isn't supported yet — supported: plane, cylinder, sphere, cone faces; line/circle edges",
          },
        };
      }
      const donor = resolution.donor;
      let name: string | null = donor.matched;
      if (!name) {
        const donorKey = `${normalizePath(donor.filePath)}:${donor.line}`;
        const taken = [...(donor.existingNames ?? []), ...(allocated.get(donorKey) ?? [])];
        name = allocateExposeName(taken);
        allocated.set(donorKey, [...(allocated.get(donorKey) ?? []), name]);

        // Two-pass expose synthesis, exactly like the foreign-sketch rail.
        const probe = fluidCadServer.synthesizeApplyFeature([pick], 'expose', name, []);
        if (!probe) {
          return { status: 404, body: { success: false, reason: 'No rendered scene' } };
        }
        if (!probe.ok) {
          return { status: 422, body: { success: false, reason: probe.reason, pick: probe.pick } };
        }
        const fileOptions = await synthesisOptionsForFile(probe.spec.filePath);
        const synth = fileOptions
          ? fluidCadServer.synthesizeApplyFeature([pick], 'expose', name, [], fileOptions)
          : probe;
        if (!synth || !synth.ok) {
          return {
            status: 422,
            body: { success: false, reason: synth && !synth.ok ? synth.reason : 'No rendered scene' },
          };
        }
        if (normalizePath(donor.filePath) === normalizePath(currentFile)) {
          exposeCreates.push(synth.spec);
        } else {
          crossFileCreates.push({ spec: synth.spec, donorFile: donor.filePath, name });
        }
      }
      resolved.push({ instanceLine: side.instanceLine, exposeName: name });
    }
    return { resolved, exposeCreates, crossFileCreates };
  };

  /**
   * Occurrence-aware side resolution: a `viaParts` level whose sub-assembly
   * doesn't export the next handle yet (`createFrom`) gets an
   * `assemblyExport` edit dispatched to that file FIRST (§7.2-style
   * sequencing, like cross-file tangent exposures), and the level resolves
   * to the binding key that edit exports. Entries are deduped and processed
   * in descending line order per file so an added `return {...}` line never
   * shifts a later entry's address. A mid-sequence failure names what was
   * and wasn't written — an extra export is inert and reused on retry.
   */
  const prepareConnectorSides = async (
    sides: (MateConnectorSideBody | undefined)[],
  ): Promise<
    | { resolved: (MateConnectorRef | undefined)[] }
    | { status: number; body: unknown }
  > => {
    type Pending = { filePath: string; insertLine: number; key?: string };
    const pending = new Map<string, Pending>();
    for (const side of sides) {
      for (const entry of side?.viaParts ?? []) {
        if ('createFrom' in entry) {
          const id = `${normalizePath(entry.createFrom.filePath)}:${entry.createFrom.insertLine}`;
          pending.set(id, { ...entry.createFrom });
        }
      }
    }
    const ordered = [...pending.entries()].sort(([, a], [, b]) =>
      a.filePath === b.filePath ? b.insertLine - a.insertLine : a.filePath.localeCompare(b.filePath));
    const written: string[] = [];
    for (const [, task] of ordered) {
      let code: string | null = null;
      if (normalizePath(task.filePath) === normalizePath(fluidCadServer.getCurrentFileName() ?? '')) {
        code = fluidCadServer.getCurrentCode();
      }
      if (code === null) {
        try {
          code = await readFile(task.filePath, 'utf8');
        } catch {
          return { status: 422, body: { success: false, reason: `could not read ${basename(task.filePath)} to export the picked instance` } };
        }
      }
      const key = await resolveExportKey(code, task.insertLine);
      if ('error' in key) {
        return { status: 422, body: { success: false, reason: `${basename(task.filePath)}: ${key.error}` } };
      }
      const sent = await dispatcher.send({
        feature: 'sketch',
        filePath: task.filePath,
        producers: [],
        parts: [],
        imports: [],
        assemblyExport: { insertLine: task.insertLine },
      });
      if (sent.error) {
        const partial = written.length > 0
          ? ` Already exported: ${written.join(', ')} (harmless — an unused export is inert and reused on retry).`
          : '';
        return {
          status: 422,
          body: { success: false, reason: `could not export ${key.name} from ${basename(task.filePath)}: ${sent.error}.${partial}` },
        };
      }
      task.key = key.name;
      written.push(`${key.name} in ${basename(task.filePath)}`);
    }
    const resolved = sides.map(side => {
      if (!side) {
        return undefined;
      }
      const { viaParts, ...rest } = side;
      if (!viaParts) {
        return rest;
      }
      return {
        ...rest,
        viaParts: viaParts.map(entry => 'keys' in entry
          ? entry.keys
          : [pending.get(`${normalizePath(entry.createFrom.filePath)}:${entry.createFrom.insertLine}`)!.key!]),
      };
    });
    return { resolved };
  };

  router.post('/assembly-mate', async (req, res) => {
    const { filePath, create, edit } = req.body ?? {};
    const editValid = edit === undefined
      || (isMatePayload(edit) && Number.isInteger((edit as any).sourceLine) && (edit as any).sourceLine >= 1);
    if (
      typeof filePath !== 'string' || filePath.length === 0
      || (create === undefined) === (edit === undefined)
      || (create !== undefined && !isMatePayload(create))
      || !editValid
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const currentFile = fluidCadServer.getCurrentFileName();
    if (!currentFile) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    if (detectKind(currentFile) !== 'assembly') {
      res.status(422).json({ success: false, reason: 'Mates target an assembly — open a *.assembly.js file first.' });
      return;
    }
    if (normalizePath(filePath) !== normalizePath(currentFile)) {
      // Sub-assembly mates live in the factory's file, and the editor host
      // applies edits against the current buffer only.
      res.status(422).json({
        success: false,
        reason: `this mate belongs to ${basename(filePath)} — open that file to edit it there.`,
      });
      return;
    }

    const payload = (create ?? edit) as MatePayloadBody;
    let assemblyMate: NonNullable<ApplyFeatureEditSpec['assemblyMate']>;
    if (payload.type === 'tangent') {
      const prepared = await prepareTangentSides(
        currentFile, [payload.geometryA!, payload.geometryB!],
      );
      if ('status' in prepared) {
        res.status(prepared.status).json(prepared.body);
        return;
      }
      // Cross-file exposures can't ride the mate transform — create each in
      // its donor file first (§7.2 sequencing). A failure part-way names the
      // exposures already written; they are inert and idempotent.
      const written: string[] = [];
      for (const create1 of prepared.crossFileCreates) {
        const sent = await dispatcher.send(create1.spec);
        if (sent.error) {
          const partial = written.length > 0
            ? ` Already written: ${written.join(', ')} (harmless — an unused expose() is inert and will be reused on retry).`
            : '';
          res.status(422).json({
            success: false,
            reason: `could not create expose('${create1.name}') in ${basename(create1.donorFile)}: ${sent.error}.${partial}`,
          });
          return;
        }
        written.push(`expose('${create1.name}') in ${basename(create1.donorFile)}`);
      }
      const resolvedPayload: AssemblyMatePayload = {
        type: 'tangent',
        geometryA: prepared.resolved[0],
        geometryB: prepared.resolved[1],
        options: payload.options,
      };
      const exposeCreates = prepared.exposeCreates.length > 0
        ? { exposeCreates: prepared.exposeCreates }
        : {};
      assemblyMate = create !== undefined
        ? { create: resolvedPayload, ...exposeCreates }
        : { edit: { ...resolvedPayload, sourceLine: (edit as any).sourceLine }, ...exposeCreates };
    } else {
      const prepared = await prepareConnectorSides([payload.connectorA, payload.connectorB]);
      if ('status' in prepared) {
        res.status(prepared.status).json(prepared.body);
        return;
      }
      const resolvedPayload = {
        ...payload,
        ...(prepared.resolved[0] !== undefined ? { connectorA: prepared.resolved[0] } : {}),
        ...(prepared.resolved[1] !== undefined ? { connectorB: prepared.resolved[1] } : {}),
      } as AssemblyMatePayload;
      assemblyMate = create !== undefined
        ? { create: resolvedPayload }
        : { edit: { ...resolvedPayload, sourceLine: (edit as any).sourceLine } };
    }

    const spec: ApplyFeatureEditSpec = {
      // Placeholder feature, exactly as insertPart rides the round trip: the
      // assemblyMate side-channel supersedes every other field.
      feature: 'sketch',
      filePath: currentFile,
      producers: [],
      parts: [],
      imports: [],
      assemblyMate,
    };
    await dispatcher.dispatch(res, spec, { success: true });
  });

  // The tangent dialog's per-pick resolver (17-mate-tangent §7.3): pick in →
  // attribution over the assembly's part templates → find-or-create exposure
  // data + the canonical contact classification (seed + G1 chain + bounds)
  // the provisional solve and the in-panel pair validation consume before
  // any expose() exists.
  router.post('/classify-contact', (req, res) => {
    const pick = req.body?.pick;
    if (!isSidePick(pick)) {
      res.status(400).json({ error: 'pick must be {shapeId, sub:{type, index}}' });
      return;
    }
    try {
      const resolution = fluidCadServer.resolveContactPick?.(pick);
      if (!resolution) {
        res.status(404).json({ error: 'No rendered scene' });
        return;
      }
      if (resolution.ok === false) {
        res.status(422).json({ success: false, reason: resolution.reason });
        return;
      }
      res.json({
        success: true,
        donor: resolution.donor,
        seed: resolution.seed,
        chain: resolution.chain,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // The mate dialog's pen button: read the connector statement's dialog-
  // editable properties from its part file. The current buffer serves the
  // open file; other files read from disk (an unsaved part buffer can be
  // stale here — the write path's editor round-trip is what verifies).
  router.post('/part-connector-properties', async (req, res) => {
    const { filePath, sourceLine } = req.body ?? {};
    if (
      typeof filePath !== 'string' || filePath.length === 0
      || !Number.isInteger(sourceLine) || sourceLine < 1
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    let code: string | null = null;
    if (normalizePath(filePath) === normalizePath(fluidCadServer.getCurrentFileName() ?? '')) {
      code = fluidCadServer.getCurrentCode();
    }
    if (code === null) {
      try {
        code = await readFile(filePath, 'utf8');
      } catch {
        res.status(404).json({ error: `could not read ${basename(filePath)}` });
        return;
      }
    }
    const result = await parseFeatureStatement(code, sourceLine);
    if (result.ok !== true) {
      res.status(422).json({ error: result.reason });
      return;
    }
    if (result.parsed.feature !== 'connector') {
      res.status(422).json({ error: `the statement on line ${sourceLine} is not a connector()` });
      return;
    }
    const { name, rotate, offset } = result.parsed;
    res.json({ name, rotate, offset });
  });

  // The pen button's apply: rewrite the connector statement in its part
  // file through the shared dispatcher. The spec's filePath is the part
  // file, so the dispatcher's current-file preflight self-skips and the
  // editor host's round-trip applies and verifies the transform.
  router.post('/part-connector-props', async (req, res) => {
    const { filePath, sourceLine, name, rotate, offset } = req.body ?? {};
    const rotateValid = rotate === null
      || (rotate !== undefined && typeof rotate === 'object' && rotate !== null
        && ['x', 'y', 'z'].includes((rotate as any).axis)
        && typeof (rotate as any).angle === 'number' && Number.isFinite((rotate as any).angle));
    if (
      typeof filePath !== 'string' || filePath.length === 0
      || !Number.isInteger(sourceLine) || sourceLine < 1
      || typeof name !== 'string' || name.length === 0
      || !rotateValid
      || (offset !== null && !isVec3(offset))
    ) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    if (!fluidCadServer.getCurrentFileName()) {
      res.status(404).json({ error: 'No active scene' });
      return;
    }
    const spec: ApplyFeatureEditSpec = {
      feature: 'sketch',
      filePath,
      producers: [],
      parts: [],
      imports: [],
      connectorProps: { sourceLine, name, rotate, offset },
    };
    await dispatcher.dispatch(res, spec, { success: true });
  });

  return router;
}
