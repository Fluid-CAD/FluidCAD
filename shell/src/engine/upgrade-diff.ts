import fs from 'fs';
import path from 'path';
import { startEngine, stopEngine } from './process';
import type { ResolvedEngine } from './resolver';
import { isFluidScriptFile } from '../file-kind';

/**
 * Rebuilding a project against another engine and reporting what moved.
 *
 * This is the mechanism behind the update promise: *updating the app must never
 * change the geometry of an existing model*. Shell updates can't, because a
 * project keeps its pin. Changing the pin can — every recent kernel fix in this
 * repo (the OCCT V8 migration, the Fillet2D micro-gap tolerance, the helix
 * sweep fix, `dimTangentEdges`) was correct and could still move a face. So the
 * pin change is an explicit gesture, and it shows its consequences first.
 *
 * The comparison is deliberately coarse — build success per feature, solid
 * count, volume, surface area, centroid. Volume is the honest signal: B-rep
 * bounding boxes overshoot badly on B-spline faces, so a bbox diff would cry
 * wolf on models that didn't change at all.
 */

export type ModelSnapshot = {
  file: string;
  state: string;
  compileError: string | null;
  features: { index: number; kind: string; name: string | null; error: string | null }[];
  solids: number;
  volumeMm3: number;
  surfaceAreaMm2: number;
};

export type EngineSnapshot = {
  version: string;
  models: ModelSnapshot[];
};

export type ModelDiff = {
  file: string;
  status: 'identical' | 'changed' | 'broken' | 'fixed';
  notes: string[];
};

export type UpgradeDiff = {
  from: string;
  to: string;
  models: ModelDiff[];
  /** Files that were not compared because the cap was hit. */
  skipped: string[];
  identical: boolean;
};

/** Comparing every file in a large workspace would take minutes; say so instead. */
const MAX_MODELS = 12;

/** Volumes differing by less than this are the same volume. */
const VOLUME_EPSILON_RATIO = 1e-6;

async function json(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  return response.json();
}

async function snapshotModel(url: string, filePath: string): Promise<ModelSnapshot> {
  const code = await fs.promises.readFile(filePath, 'utf8');
  const render = await fetch(`${url}/api/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filePath, code }),
  }).then((r) => r.json());

  const summary = await json(`${url}/api/scene/summary`);
  const shapes = await json(`${url}/api/scene/shapes`);

  const features = (summary?.objects ?? []).map((object: any) => ({
    index: object.index,
    kind: object.uniqueKind ?? object.kind,
    name: object.name ?? null,
    error: object.hasError ? object.errorMessage ?? 'failed to build' : null,
  }));

  const solidIds: string[] = (shapes?.shapes ?? [])
    .filter((shape: any) => shape.type === 'solid')
    .map((shape: any) => shape.shapeId);

  let volumeMm3 = 0;
  let surfaceAreaMm2 = 0;
  for (const shapeId of solidIds) {
    const props = await json(`${url}/api/shape-properties?shapeId=${encodeURIComponent(shapeId)}`);
    volumeMm3 += props?.volumeMm3 ?? 0;
    surfaceAreaMm2 += props?.surfaceAreaMm2 ?? 0;
  }

  return {
    file: filePath,
    state: render?.state ?? 'unknown',
    compileError: render?.compileError?.message ?? null,
    features,
    solids: solidIds.length,
    volumeMm3,
    surfaceAreaMm2,
  };
}

/** Every model (part or assembly file) in the workspace, shallowest first, capped. */
export function findModels(workspacePath: string): { models: string[]; skipped: string[] } {
  const found: string[] = [];
  const queue: string[] = [''];
  while (queue.length > 0) {
    const relDir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(workspacePath, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        queue.push(rel);
      } else if (entry.isFile() && isFluidScriptFile(entry.name)) {
        found.push(path.join(workspacePath, rel));
      }
    }
  }
  found.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
  return { models: found.slice(0, MAX_MODELS), skipped: found.slice(MAX_MODELS) };
}

/** Start one engine, render every model through it, stop it. */
export async function snapshotWithEngine(
  engine: ResolvedEngine,
  workspacePath: string,
  models: string[],
  onProgress?: (message: string) => void,
): Promise<EngineSnapshot> {
  const started = await startEngine(engine, workspacePath, {});
  try {
    const snapshots: ModelSnapshot[] = [];
    for (const model of models) {
      onProgress?.(`Building ${path.basename(model)} with engine ${engine.version}…`);
      snapshots.push(await snapshotModel(started.url, model));
    }
    return { version: engine.version, models: snapshots };
  } finally {
    stopEngine(started.child);
  }
}

function sameNumber(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / scale < VOLUME_EPSILON_RATIO;
}

export function compareSnapshots(
  before: EngineSnapshot,
  after: EngineSnapshot,
  skipped: string[] = [],
): UpgradeDiff {
  const models: ModelDiff[] = [];

  for (const beforeModel of before.models) {
    const afterModel = after.models.find((entry) => entry.file === beforeModel.file);
    if (!afterModel) {
      continue;
    }
    const notes: string[] = [];

    const beforeBroken = beforeModel.compileError !== null;
    const afterBroken = afterModel.compileError !== null;
    if (!beforeBroken && afterBroken) {
      notes.push(`Fails to build: ${afterModel.compileError}`);
    } else if (beforeBroken && !afterBroken) {
      notes.push('Now builds (it did not before).');
    }

    const beforeFailures = beforeModel.features.filter((feature) => feature.error);
    const afterFailures = afterModel.features.filter((feature) => feature.error);
    for (const failure of afterFailures) {
      if (!beforeFailures.some((entry) => entry.index === failure.index)) {
        notes.push(`${failure.kind}${failure.name ? ` "${failure.name}"` : ''} now fails: ${failure.error}`);
      }
    }
    for (const failure of beforeFailures) {
      if (!afterFailures.some((entry) => entry.index === failure.index)) {
        notes.push(`${failure.kind}${failure.name ? ` "${failure.name}"` : ''} now builds.`);
      }
    }

    if (beforeModel.solids !== afterModel.solids) {
      notes.push(`Solids: ${beforeModel.solids} → ${afterModel.solids}`);
    }
    if (!sameNumber(beforeModel.volumeMm3, afterModel.volumeMm3)) {
      const delta = afterModel.volumeMm3 - beforeModel.volumeMm3;
      const percent = beforeModel.volumeMm3 === 0 ? null : (delta / beforeModel.volumeMm3) * 100;
      notes.push(
        `Volume: ${beforeModel.volumeMm3.toFixed(3)} → ${afterModel.volumeMm3.toFixed(3)} mm³` +
          (percent === null ? '' : ` (${percent > 0 ? '+' : ''}${percent.toFixed(3)}%)`),
      );
    }
    if (!sameNumber(beforeModel.surfaceAreaMm2, afterModel.surfaceAreaMm2)) {
      notes.push(
        `Surface area: ${beforeModel.surfaceAreaMm2.toFixed(3)} → ${afterModel.surfaceAreaMm2.toFixed(3)} mm²`,
      );
    }

    const status: ModelDiff['status'] = afterBroken && !beforeBroken
      ? 'broken'
      : beforeBroken && !afterBroken
        ? 'fixed'
        : notes.length > 0
          ? 'changed'
          : 'identical';

    models.push({ file: beforeModel.file, status, notes });
  }

  return {
    from: before.version,
    to: after.version,
    models,
    skipped,
    identical: models.every((model) => model.status === 'identical'),
  };
}
