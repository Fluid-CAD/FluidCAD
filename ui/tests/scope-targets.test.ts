import { describe, it, expect, afterEach } from 'vitest';
import {
  enclosingPartLocOf, partScopedSolidTargets, ScopeTargetList, scopePartLocation,
} from '../src/interactive/create-feature/scope-targets';
import { setActivePartLocationProvider } from '../src/helpers/scene-utils';
import type { SceneObjectRender, SourceLocation } from '../src/types';

const FILE = '/ws/model.fluid.js';

function partRow(name: string, line: number): SceneObjectRender {
  return {
    id: `part-${name}`,
    name,
    type: 'part',
    sourceLocation: { filePath: FILE, line, column: 0 },
  } as SceneObjectRender;
}

function solidRow(name: string, line: number, parentId?: string): SceneObjectRender {
  return {
    id: `solid-${name}-${line}`,
    name,
    type: 'extrude',
    parentId,
    sourceLocation: { filePath: FILE, line, column: 0 },
    sceneShapes: [{ shapeId: `shape-${name}`, shapeType: 'solid' }],
  } as SceneObjectRender;
}

function sketchRow(name: string, line: number, parentId?: string): SceneObjectRender {
  return {
    id: `sketch-${name}-${line}`,
    name,
    type: 'sketch',
    parentId,
    sourceLocation: { filePath: FILE, line, column: 0 },
  } as SceneObjectRender;
}

/**
 * Two parts with a solid each, a top-level solid, and a sketch inside part A
 * — the standard fixture: A(line 3) { boxA(4), sk(5) }, B(7) { boxB(8) },
 * free(10).
 */
function twoPartScene(): SceneObjectRender[] {
  const a = partRow('A', 3);
  const b = partRow('B', 7);
  return [
    a,
    solidRow('boxA', 4, a.id),
    sketchRow('sk', 5, a.id),
    b,
    solidRow('boxB', 8, b.id),
    solidRow('free', 10),
  ];
}

afterEach(() => setActivePartLocationProvider(() => null));

describe('partScopedSolidTargets', () => {
  it('offers only the part\'s own solids with a part location', () => {
    const options = partScopedSolidTargets(twoPartScene(), { filePath: FILE, line: 3, column: 0 });
    expect(options.map(o => o.line)).toEqual([4]);
  });

  it('offers only top-level solids without a part location', () => {
    const options = partScopedSolidTargets(twoPartScene(), null);
    expect(options.map(o => o.line)).toEqual([10]);
  });

  it('offers nothing when the part location no longer resolves', () => {
    const options = partScopedSolidTargets(twoPartScene(), { filePath: FILE, line: 99, column: 0 });
    expect(options).toEqual([]);
  });
});

describe('enclosingPartLocOf / scopePartLocation', () => {
  it('resolves a statement inside a part to the part row', () => {
    expect(enclosingPartLocOf({ filePath: FILE, line: 5 }, twoPartScene()))
      .toEqual({ filePath: FILE, line: 3, column: 0 });
  });

  it('resolves a top-level statement to null', () => {
    expect(enclosingPartLocOf({ filePath: FILE, line: 10 }, twoPartScene())).toBeNull();
  });

  it('a chosen primary input wins over the active part (producers win)', () => {
    setActivePartLocationProvider(() => ({ filePath: FILE, line: 7, column: 0 }));
    expect(scopePartLocation({ filePath: FILE, line: 5 }, twoPartScene()))
      .toEqual({ filePath: FILE, line: 3, column: 0 });
  });

  it('falls back to the active part without a primary input', () => {
    setActivePartLocationProvider(() => ({ filePath: FILE, line: 7, column: 0 }));
    expect(scopePartLocation(null, twoPartScene()))
      .toEqual({ filePath: FILE, line: 7, column: 0 });
  });

  it('is null without a primary input or an active part', () => {
    expect(scopePartLocation(null, twoPartScene())).toBeNull();
  });
});

describe('ScopeTargetList', () => {
  function listWith(partLoc: SourceLocation | null): { list: ScopeTargetList; scene: SceneObjectRender[] } {
    const list = new ScopeTargetList();
    const scene = twoPartScene();
    list.setScene(scene, partLoc);
    return { list, scene };
  }

  it('toggles picked solids and projects them into chips and refs', () => {
    const { list } = listWith({ filePath: FILE, line: 3, column: 0 });
    const option = list.optionForShapeId('shape-boxA')!;
    expect(option.line).toBe(4);
    list.toggle(option);
    expect(list.chips()).toHaveLength(1);
    expect(list.shapeIds()).toEqual(['shape-boxA']);
    expect(list.createRefs()).toEqual([{ filePath: FILE, line: 4, column: 0 }]);
    // The same pick toggles it back off.
    list.toggle(option);
    expect(list.isEmpty).toBe(true);
  });

  it('does not resolve picks outside the part restriction', () => {
    const { list } = listWith({ filePath: FILE, line: 3, column: 0 });
    expect(list.optionForShapeId('shape-boxB')).toBeUndefined();
    expect(list.optionForShapeId('shape-free')).toBeUndefined();
  });

  it('drops a chosen option that left the part scope on the next scene', () => {
    const { list, scene } = listWith(null);
    list.toggle(list.optionForShapeId('shape-free')!);
    // The restriction tightens to part A — the free solid is out of scope.
    list.setScene(scene, { filePath: FILE, line: 3, column: 0 });
    expect(list.isEmpty).toBe(true);
  });

  it('keeps seeds verbatim and resolves them into options at the boundary', () => {
    const { list, scene } = listWith(null);
    list.seedKeeps({ scopeTexts: ['free', 'other'], scopeRefs: [{ line: 10, column: 6 }, null] }, FILE);
    expect(list.editRefs()).toEqual([
      { kind: 'verbatim', sourceIndex: 0 },
      { kind: 'verbatim', sourceIndex: 1 },
    ]);
    // A plain re-render keeps both text-addressed.
    list.setScene(scene, null);
    expect(list.editRefs().every(ref => ref.kind === 'verbatim')).toBe(true);
    // The boundary render converts the addressable keep into its option; the
    // unresolvable one stays verbatim.
    list.setScene(scene, null, { resolveKeeps: true });
    expect(list.editRefs()).toEqual([
      { kind: 'feature', filePath: FILE, line: 10, column: 0 },
      { kind: 'verbatim', sourceIndex: 1 },
    ]);
  });

  it('toggling the statement a keep resolved to removes the keep chip', () => {
    const { list, scene } = listWith(null);
    list.seedKeeps({ scopeTexts: ['free'], scopeRefs: [{ line: 10, column: 6 }] }, FILE);
    list.setScene(scene, null);
    list.toggle(list.optionForShapeId('shape-free')!);
    expect(list.isEmpty).toBe(true);
  });
});
