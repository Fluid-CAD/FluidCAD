import { describe, it, expect } from 'vitest';
import { collectRenderedPartProperties } from '../src/fluidcad-server/properties.ts';

// The server reads a definition's default variant off what the render
// already built — never materializing — so a `part()` binding can offer
// `def.properties.<name>` from the values that variant published.
describe('collectRenderedPartProperties', () => {
  const FILE = '/ws/box.part.js';
  const location = (line: number) => ({ filePath: `virtual:live-render:${FILE}`, line, column: 20 });

  function partObject(spec: {
    line?: number;
    properties: { name: string; value: string | number }[];
    params?: { label: string; defaultValue: number; currentValue: number }[];
    type?: string;
  }) {
    return {
      getType: () => spec.type ?? 'part',
      getSourceLocation: () => (spec.line === undefined ? null : location(spec.line)),
      getProperties: () => spec.properties,
      params: spec.params,
    };
  }

  it('lists each located default variant with its properties by name, the virtual prefix stripped', () => {
    const scene = { getAllSceneObjects: () => [
      partObject({ line: 3, properties: [{ name: 'lidClearance', value: 1 }, { name: 'finish', value: 'oak' }] }),
      partObject({ line: 8, properties: [] }),
      { getType: () => 'sketch' },
      partObject({ properties: [{ name: 'unlocated', value: 1 }] }),
    ] };
    expect(collectRenderedPartProperties(scene)).toEqual([
      { sourceLocation: { filePath: FILE, line: 3, column: 20 }, properties: { lidClearance: 1, finish: 'oak' } },
      { sourceLocation: { filePath: FILE, line: 8, column: 20 }, properties: {} },
    ]);
  });

  it('keeps a scoped build only while every parameter sits at its default', () => {
    const scene = { getAllSceneObjects: () => [
      partObject({ line: 3, properties: [{ name: 'w', value: 300 }], params: [{ label: 'Width', defaultValue: 500, currentValue: 300 }] }),
      partObject({ line: 3, properties: [{ name: 'w', value: 500 }], params: [{ label: 'Width', defaultValue: 500, currentValue: 500 }] }),
    ] };
    expect(collectRenderedPartProperties(scene)).toEqual([
      { sourceLocation: { filePath: FILE, line: 3, column: 20 }, properties: { w: 500 } },
    ]);
  });

  it('reads an empty scene, and one whose objects it cannot list', () => {
    expect(collectRenderedPartProperties({ getAllSceneObjects: () => [] })).toEqual([]);
    expect(collectRenderedPartProperties({})).toEqual([]);
  });
});
