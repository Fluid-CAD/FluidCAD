import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { SceneIndex } from '../src/helpers/scene-index';
import {
  activeScopeObjects,
  findActiveObject,
  findEnclosingPartRow,
  isTopLevel,
  setActivePartLocationProvider,
} from '../src/helpers/scene-utils';
import { collectExtrudeProfiles, collectSketchProfiles, collectWireSources, resolveSketchRow } from '../src/interactive/create-feature/sketch-profiles';
import { collectSolidTargets } from '../src/interactive/create-feature/solid-targets';
import { collectRepeatTargets, resolveRepeatTargetRow } from '../src/interactive/create-feature/repeat-targets';
import type { SceneObjectRender } from '../src/types';
import { buildHeavyScene } from './fixtures/heavy-scene';

// The scans the index replaced, kept here as the reference semantics.
const scan = {
  byId: (scene: SceneObjectRender[], id: string | null | undefined) =>
    id == null ? undefined : scene.find(o => o.id === id),
  children: (scene: SceneObjectRender[], id: string) => scene.filter(o => o.parentId === id),
  isTopLevel: (scene: SceneObjectRender[], obj: SceneObjectRender) =>
    !obj.parentId || scan.byId(scene, obj.parentId)?.type === 'part',
  enclosing: (scene: SceneObjectRender[], obj: SceneObjectRender, type: string) => {
    let current: SceneObjectRender | undefined = obj;
    while (current?.parentId != null) {
      current = scan.byId(scene, current.parentId);
      if (current?.type === type) {
        return current;
      }
    }
    return undefined;
  },
  hasRenderedGeometry: (scene: SceneObjectRender[], obj: SceneObjectRender): boolean => {
    if ((obj.sceneShapes ?? []).some(s => !s.isMetaShape && !s.isGuide && (s.meshes?.length ?? 0) > 0)) {
      return true;
    }
    return scene.some(child => child !== obj && child.parentId != null && child.parentId === obj.id
      && scan.hasRenderedGeometry(scene, child));
  },
  subtreeRebuilt: (scene: SceneObjectRender[], id: string): boolean => {
    const root = scan.byId(scene, id);
    if (root && !root.fromCache) {
      return true;
    }
    return scan.children(scene, id).some(child => child.id != null && scan.subtreeRebuilt(scene, child.id));
  },
};

afterEach(() => {
  setActivePartLocationProvider(() => null);
});

describe('SceneIndex', () => {
  for (const interleave of [false, true]) {
    describe(interleave ? 'interleaved (lazily materialized) parts' : 'contiguous parts', () => {
      const scene = buildHeavyScene({ parts: 6, polygonPoints: 12, interleave });
      const index = SceneIndex.of(scene);

      it('answers every lookup exactly like the scan it replaced', () => {
        for (const obj of scene) {
          expect(index.byId(obj.id)).toBe(scan.byId(scene, obj.id));
          expect(index.parent(obj)).toBe(scan.byId(scene, obj.parentId));
          expect([...index.children(obj.id)]).toEqual(scan.children(scene, obj.id!));
          expect(index.isTopLevel(obj)).toBe(scan.isTopLevel(scene, obj));
          expect(index.enclosing(obj, 'part')).toBe(scan.enclosing(scene, obj, 'part'));
          expect(index.enclosing(obj, 'sketch')).toBe(scan.enclosing(scene, obj, 'sketch'));
          expect(index.hasRenderedGeometry(obj)).toBe(scan.hasRenderedGeometry(scene, obj));
          expect(index.subtreeRebuilt(obj.id)).toBe(scan.subtreeRebuilt(scene, obj.id!));
          expect(index.position(obj)).toBe(scene.indexOf(obj));
        }
      });

      it('keeps the helpers on the same answers', () => {
        for (const obj of scene) {
          expect(isTopLevel(obj, scene)).toBe(scan.isTopLevel(scene, obj));
          expect(findEnclosingPartRow(obj, scene)).toBe(scan.enclosing(scene, obj, 'part'));
          const parent = scan.byId(scene, obj.parentId);
          expect(resolveSketchRow(obj, scene)).toBe(obj.type === 'sketch' ? obj : parent?.type === 'sketch' ? parent : undefined);
          const insideSketch = scan.enclosing(scene, obj, 'sketch') !== undefined;
          const repeatable = !!obj.sourceLocation && !!obj.type && !['sketch', 'plane', 'axis'].includes(obj.type) && !insideSketch;
          expect(resolveRepeatTargetRow(obj, scene)).toBe(repeatable ? obj : undefined);
        }
      });

      it('scopes to the active part, else to the top-level rows', () => {
        expect(activeScopeObjects(scene)).toEqual(scene.filter(o => scan.isTopLevel(scene, o)));
        const part = scene.find(o => o.id === 'part-2')!;
        setActivePartLocationProvider(() => part.sourceLocation!);
        expect(activeScopeObjects(scene)).toEqual(scan.children(scene, 'part-2'));
        expect(findActiveObject(scene)?.id).toBe('part-2/sketch-open');
      });

      it('offers only the sketches that still draw geometry', () => {
        const offered = collectSketchProfiles(scene).map(o => o.line);
        const expected = scene
          .filter(o => o.type === 'sketch' && scan.hasRenderedGeometry(scene, o))
          .map(o => o.sourceLocation!.line);
        expect(offered.sort()).toEqual(expected.sort());
        expect(offered.length).toBe(6);
      });

      it('targets solids outside sketches only', () => {
        expect(collectSolidTargets(scene).map(o => o.shapeIds).flat().sort()).toEqual(
          [...Array.from({ length: 6 }, (_, p) => `part-${p}/solid`), 'loose/solid'].sort());
      });
    });
  }

  it('is shared by every reader of the same list, and per list', () => {
    const scene = buildHeavyScene({ parts: 2, polygonPoints: 3 });
    expect(SceneIndex.of(scene)).toBe(SceneIndex.of(scene));
    expect(SceneIndex.of([...scene])).not.toBe(SceneIndex.of(scene));
  });

  it('re-indexes a list that grew since it was indexed', () => {
    const scene = buildHeavyScene({ parts: 1, polygonPoints: 1 });
    expect(SceneIndex.of(scene).byId('late')).toBeUndefined();
    scene.push({ id: 'late', sceneShapes: [], ownShapes: [] });
    expect(SceneIndex.of(scene).byId('late')).toBe(scene[scene.length - 1]);
  });

  it('survives a malformed parent cycle', () => {
    const a: SceneObjectRender = { id: 'a', parentId: 'b', sceneShapes: [], ownShapes: [], fromCache: true };
    const b: SceneObjectRender = { id: 'b', parentId: 'a', sceneShapes: [], ownShapes: [], fromCache: true };
    const index = SceneIndex.of([a, b]);
    expect(index.enclosing(a, 'part')).toBeUndefined();
    expect(index.ancestors(a)).toEqual([b]);
    expect(index.hasRenderedGeometry(a)).toBe(false);
    expect(index.subtreeRebuilt('a')).toBe(false);
  });
});

/**
 * Scaling, not wall-clock: the cascade a render runs over the scene helpers
 * must grow roughly linearly with scene size. Going from n to 4n rows costs
 * ~4x when linear and ~16x when quadratic; the bound sits between the two.
 */
describe('scene helpers scale linearly with scene size', () => {
  function cascade(scene: SceneObjectRender[]): void {
    findActiveObject(scene);
    collectSketchProfiles(scene);
    collectExtrudeProfiles(scene);
    collectWireSources(scene);
    collectSolidTargets(scene);
    collectRepeatTargets(scene);
    const index = SceneIndex.of(scene);
    for (const obj of scene) {
      if (obj.type === 'part') {
        index.subtreeRebuilt(obj.id);
        index.children(obj.id);
      }
    }
  }

  function bestOf(runs: number, options: Parameters<typeof buildHeavyScene>[0]): number {
    let best = Infinity;
    for (let i = 0; i < runs; i++) {
      // A fresh list per run: the index is per list, so every run pays for it.
      const scene = buildHeavyScene(options);
      const start = performance.now();
      cascade(scene);
      best = Math.min(best, performance.now() - start);
    }
    return best;
  }

  it('n → 4n rows costs well under 16x', () => {
    const small = { parts: 20, polygonPoints: 100, interleave: true };
    const large = { parts: 20, polygonPoints: 400, interleave: true };
    bestOf(2, small);
    const base = bestOf(5, small);
    const scaled = bestOf(5, large);
    expect(buildHeavyScene(large).length).toBeGreaterThan(3.5 * buildHeavyScene(small).length);
    expect(scaled / Math.max(base, 0.05)).toBeLessThan(8);
  });
});

/**
 * The gate that keeps the scans out: looking a scene row up by `id`, or
 * collecting rows by `parentId`, with an array scan is O(n) per question and
 * O(n²) per render. Go through SceneIndex instead. Arrays that are not scene
 * lists (solver records, dialog options, gizmo handles) are listed by file.
 */
describe('no id/parentId scans over scene lists', () => {
  const SRC = resolve(import.meta.dirname, '../src');
  const SCAN = /\.(find|findLast|findIndex|some|every|filter)\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\2\.(id|parentId)\s*===/;
  const NOT_SCENE_LISTS = new Set([
    'helpers/scene-index.ts',
    'sketch-solver-client/model.ts',
    'sketch-solver-client/dof-state.ts',
    'interactive/solved-constraint-toolbar/solved-constraint-toolbar.ts',
    'interactive/solved-constraint-toolbar/solved-constraint-toolbar-service.ts',
    'interactive/drag-move-handler/solved-drag-handler.ts',
    'interactive/gizmo/transform-gizmo.ts',
  ]);

  function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...tsFiles(path));
      } else if (entry.name.endsWith('.ts')) {
        out.push(path);
      }
    }
    return out;
  }

  it('finds none', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const name = relative(SRC, file).replace(/\\/g, '/');
      if (NOT_SCENE_LISTS.has(name)) {
        continue;
      }
      readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
        if (SCAN.test(text)) {
          offenders.push(`${name}:${i + 1}: ${text.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
