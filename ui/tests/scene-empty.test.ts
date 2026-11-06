// The signal behind the blank-document toolbar: with nothing modelled, every
// feature service ORs `Viewer.sceneIsEmpty` into its own availability rule so
// the bar shows all of its buttons instead of just Import / Sketch / Plane.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { isSceneEmpty } from '../src/helpers/scene-utils';
import type { SceneObjectPart, SceneObjectRender } from '../src/types';

function row(type: string, shapes: Partial<SceneObjectPart>[] = []): SceneObjectRender {
  return { id: `${type}-1`, name: type, type, sceneShapes: shapes, ownShapes: shapes } as SceneObjectRender;
}

const SOLID: Partial<SceneObjectPart> = { shapeType: 'solid' };

describe('isSceneEmpty', () => {
  it('treats a scene with no objects at all as empty', () => {
    expect(isSceneEmpty([])).toBe(true);
  });

  it('treats construction-only documents as empty', () => {
    // Declaring a plane or an axis models nothing — the toolbar must not
    // collapse back to three buttons the moment one is created.
    expect(isSceneEmpty([row('plane'), row('axis'), row('select')])).toBe(true);
  });

  it('treats a helix as construction geometry', () => {
    // A helix is a wire: you sweep a profile along it, so on its own there is
    // still nothing to build from (and Sweep has to stay reachable to use it).
    expect(isSceneEmpty([row('helix', [{ shapeType: 'edge' }])])).toBe(true);
    expect(isSceneEmpty([row('axis'), row('helix', [{ shapeType: 'edge' }])])).toBe(true);
  });

  it('treats a sketch as an input, not modelled material', () => {
    // A finished sketch with nothing built on it must keep the whole toolbar
    // the blank document offered before it was drawn.
    expect(isSceneEmpty([row('plane'), row('sketch', [{ shapeType: 'wire' }])])).toBe(true);
  });

  it('is not empty once a solid is modelled', () => {
    expect(isSceneEmpty([row('extrude', [SOLID])])).toBe(false);
    expect(isSceneEmpty([row('helix', [{ shapeType: 'edge' }]), row('pipe', [SOLID])])).toBe(false);
  });

  it('ignores meta and guide shapes', () => {
    // Trim regions and preview guides are overlays, not modelled material.
    expect(isSceneEmpty([row('box', [{ shapeType: 'solid', isMetaShape: true }])])).toBe(true);
    expect(isSceneEmpty([row('box', [{ shapeType: 'solid', isGuide: true }])])).toBe(true);
  });
});

describe('blank-document toolbar coverage', () => {
  const SRC = resolve(import.meta.dirname, '../src');

  // Visibility voters that never hide a tool for want of scene content, so a
  // blank document has nothing to override.
  const EXEMPT: Record<string, string> = {
    'ui/history-toolbar.ts': 'undo/redo availability, not a feature tool',
    'interactive/sketch-toolbar-service.ts': 'the sketch tools follow sketch mode',
    'interactive/create-feature/plane-service.ts': 'always visible',
    'interactive/create-feature/schema/schema-feature-service.ts': 'always visible',
    'interactive/create-feature/schema/custom-features-menu.ts': 'follows installed packages, not the scene',
  };

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(path);
      }
      return path.endsWith('.ts') ? [path] : [];
    });
  }

  it('every tool that hides itself on scene content also shows on a blank document', () => {
    // A tool added later that gates on solids alone drops off the empty
    // scene's toolbar — the bug this rule exists to prevent.
    const missing = sourceFiles(SRC)
      .filter((file) => readFileSync(file, 'utf8').includes('navbar.setGroupVisible('))
      .map((file) => relative(SRC, file))
      .filter((file) => !(file in EXEMPT))
      .filter((file) => !readFileSync(join(SRC, file), 'utf8').includes('sceneIsEmpty'));
    expect(missing).toEqual([]);
  });
});
