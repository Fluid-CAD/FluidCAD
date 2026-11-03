import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FluidCadServer } from '../src/fluidcad-server/index.ts';
import type { SceneRenderedData } from '../src/fluidcad-server/render-types.ts';
import { LocalSceneHost } from '../src/host/local-scene-host.ts';

// The assembly scene leak (plans/assembly-scene-leak.md), over a real
// workspace: every render of an assembly — the editor's live updates, the
// generated-assembly preview's ticks (one render each), a forced recompute —
// replaces the session's scene, and the server only drops the old one. The
// engine's compare must have freed it: once the template cache lets go of
// what it keeps, no shape wrapper of a replaced scene is alive unless the
// scene on screen holds it. The model has every kind of part an assembly
// rebuilds: a generated assembly (the S4 fixture's crate), a definePart
// variant (its spur) and an ordinary part inserted twice.

const FIXTURE = path.resolve(__dirname, 'fixtures/generated-workspace');

const POST = [
  `import { part, param, cylinder } from 'fluidcad/core';`,
  ``,
  `export const post = part('Post', () => {`,
  `  const height = param('Height', 20);`,
  `  cylinder(5, height);`,
  `});`,
  ``,
].join('\n');

/** The model with these values typed in. */
function shop(values: { width: number; teeth: number; height: number }): string {
  return [
    `import { assembly, insert } from 'fluidcad/core';`,
    `import { crate } from './assemblies/crate.assembly.js';`,
    `import { spurPart } from './parts/spur.part.js';`,
    `import { post } from './parts/post.part.js';`,
    ``,
    `export const shop = assembly('shop', () => {`,
    `  insert(crate, { width: ${values.width} }).name('crate1');`,
    `  insert(spurPart, { teeth: ${values.teeth} }).name('gear');`,
    `  insert(post, { Height: ${values.height} }).name('post1');`,
    `  insert(post, { Height: 50 }).name('post2');`,
    `});`,
    ``,
  ].join('\n');
}

type Row = { type: string; hasError?: boolean; errorMessage?: string; sceneShapes?: { shapeId: string }[] };

function errorsOf(result: Row[]): string[] {
  return result.flatMap(row => (row.hasError ? [`${row.type}: ${row.errorMessage}`] : []));
}

/**
 * The shape wrappers a scene's objects reach, walked as the engine's
 * disposal pass walks them — duck-typed: the scene comes from the
 * workspace's engine, another module instance than this file's.
 */
class SceneShapes {
  static of(scenes: any[]): Set<any> {
    const shapes = new Set<any>();
    const seen = new Set<unknown>();
    for (const scene of scenes) {
      for (const obj of scene.getAllSceneObjects()) {
        for (const value of obj.getFullState().values()) {
          SceneShapes.walk(value, shapes, seen);
        }
      }
    }
    return shapes;
  }

  private static walk(value: any, shapes: Set<any>, seen: Set<unknown>): void {
    if (!value || typeof value !== 'object' || seen.has(value)) {
      return;
    }
    seen.add(value);
    if (typeof value.isReleased === 'function' && typeof value.getLinkedShapes === 'function') {
      shapes.add(value);
      for (const linked of value.getLinkedShapes()) {
        SceneShapes.walk(linked, shapes, seen);
      }
      return;
    }
    if (typeof value.getFullState === 'function') {
      return;
    }
    if (Array.isArray(value) || value instanceof Set) {
      for (const item of value) {
        SceneShapes.walk(item, shapes, seen);
      }
      return;
    }
    if (value instanceof Map) {
      for (const item of value.values()) {
        SceneShapes.walk(item, shapes, seen);
      }
      return;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      for (const item of Object.values(value)) {
        SceneShapes.walk(item, shapes, seen);
      }
    }
  }
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const table = vi.spyOn(console, 'table').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    log.mockRestore();
    table.mockRestore();
    warn.mockRestore();
  }
}

describe('assembly renders free the scene they replace', () => {
  let root: string;
  let host: LocalSceneHost;
  let server: FluidCadServer;
  let file: string;
  /** Every scene the engine started since the workspace opened. */
  let scenes: any[];
  let stopWatching: () => void;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-assembly-leak-')).replace(/\\/g, '/');
    fs.cpSync(FIXTURE, root, { recursive: true });
    fs.writeFileSync(path.join(root, 'parts/post.part.js'), POST);
    file = `${root}/shop.assembly.js`;
    fs.writeFileSync(file, shop({ width: 40, teeth: 24, height: 20 }));
    host = new LocalSceneHost();
    server = new FluidCadServer(host);
    await quietly(() => server.init(root));
    const manager = (server as any).sceneManager;
    manager.clearGeneratedTemplates();
    scenes = [];
    stopWatching = manager.onSceneStarted((scene: any) => { scenes.push(scene); });
  });

  afterEach(async () => {
    stopWatching();
    await host.server?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** The scene the session shows now. */
  const current = (): any => (server as any).previousScenes.get(server.getCurrentFileName());

  /** Wrappers of replaced scenes still alive that the scene on screen doesn't hold — after the template cache let go of its own. */
  const leftover = (): number => {
    (server as any).sceneManager.clearGeneratedTemplates();
    const live = SceneShapes.of([current()]);
    return [...SceneShapes.of(scenes.filter(scene => scene !== current()))]
      .filter(shape => !shape.isReleased() && !live.has(shape)).length;
  };

  const volumeOf = (data: SceneRenderedData): number => (data.result as Row[])
    .flatMap(row => row.sceneShapes ?? [])
    .reduce((sum, shape) => sum + (server.getShapeProperties(shape.shapeId)?.volumeMm3 ?? 0), 0);

  it('keeps no replaced scene alive across live updates and preview ticks', async () => {
    const opened = (await quietly(() => server.updateLiveCode(file, shop({ width: 40, teeth: 24, height: 20 }))))!;
    expect(errorsOf(opened.result as Row[])).toEqual([]);

    // Preview ticks: each a render of the edited code as the session's scene
    // (a crate width dragged, a gear's teeth typed), at both tiers.
    const ticks = [
      { width: 45, teeth: 24, height: 20, detail: 'preview' as const },
      { width: 50, teeth: 30, height: 20, detail: 'preview' as const },
      { width: 50, teeth: 30, height: 20, detail: 'full' as const },
      { width: 55, teeth: 24, height: 30, detail: 'preview' as const },
      { width: 55, teeth: 24, height: 30, detail: 'full' as const },
    ];
    for (const { detail, ...values } of ticks) {
      const answer = await quietly(() => server.renderPreview({ token: 'leak-1', code: shop(values), pins: {}, detail }));
      expect(answer?.ok).toBe(true);
      expect(errorsOf((answer as any).data.result)).toEqual([]);
    }
    // The editor's own renders: an edit, another, back to what was saved.
    for (const values of [{ width: 60, teeth: 36, height: 40 }, { width: 40, teeth: 24, height: 25 }, { width: 40, teeth: 24, height: 20 }]) {
      const data = (await quietly(() => server.updateLiveCode(file, shop(values))))!;
      expect(errorsOf(data.result as Row[])).toEqual([]);
    }
    expect(scenes.length).toBe(9);

    expect(leftover()).toBe(0);
    // The scene on screen renders on: none of its wrappers was freed.
    expect([...SceneShapes.of([current()])].some(shape => shape.isReleased())).toBe(false);
    const again = (await quietly(() => server.updateLiveCode(file, shop({ width: 40, teeth: 30, height: 20 }))))!;
    expect(errorsOf(again.result as Row[])).toEqual([]);
    // crate 40 × 30 × (20 + 3); the gear: r = 2 × 32 / 2 = 32, 10 deep; posts r 5, 20 and 50 high.
    expect(volumeOf(again)).toBeCloseTo(40 * 30 * 23 + Math.PI * 32 ** 2 * 10 + Math.PI * 25 * 70, 0);
    expect(leftover()).toBe(0);
  });

  it('frees the replaced scene through a forced recompute', async () => {
    await quietly(() => server.updateLiveCode(file, shop({ width: 40, teeth: 24, height: 20 })));
    await quietly(() => server.updateLiveCode(file, shop({ width: 45, teeth: 30, height: 30 })));
    const data = (await quietly(() => server.recomputeCurrentFile(true)))!;
    expect(errorsOf(data.result as Row[])).toEqual([]);
    expect(leftover()).toBe(0);
  });
});
