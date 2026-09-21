import { describe, expect, it } from 'vitest';
import { SelectHoist } from '../src/select-hoist.ts';

describe('SelectHoist', () => {
  it('lifts a selection written inside a chained call and leaves root arguments inline', async () => {
    const result = await SelectHoist.extract(
      `loft(select(face().onPlane('yz')), f.sideFaces(0)).connect(select(edge().farthest('x')).end(), f.startEdges(0).start())`,
      'late', new Set(), true,
    );
    expect(result.decls).toEqual([`const sel = select(edge().farthest('x'));`]);
    expect(result.statement).toBe(
      `loft(select(face().onPlane('yz')), f.sideFaces(0)).connect(sel.end(), f.startEdges(0).start())`,
    );
  });

  it('reaches a selection nested in an accessor inside the chained call, across every .connect()', async () => {
    const result = await SelectHoist.extract(
      `loft(a, b).connect(e.startEdges(select(edge())).start(), [0, 0, 0]).connect(select(edge().nearest('x')).end(), [1, 0, 0]).new()`,
      'late', new Set(['sel']), false,
    );
    expect(result.decls).toEqual([`const sel2 = select(edge())`, `const sel3 = select(edge().nearest('x'))`]);
    expect(result.statement).toBe(
      `loft(a, b).connect(e.startEdges(sel2).start(), [0, 0, 0]).connect(sel3.end(), [1, 0, 0]).new()`,
    );
  });

  it('lifts a guide selection the same way', async () => {
    const result = await SelectHoist.extract(`loft(a, b).guides(select(edge().nearest('x'))).new()`, 'late', new Set(), true);
    expect(result.decls).toEqual([`const sel = select(edge().nearest('x'));`]);
    expect(result.statement).toBe(`loft(a, b).guides(sel).new()`);
  });

  it('keeps an accessor argument on a plain name inline', async () => {
    const text = `fillet(2, e.sideFaces(select(face())))`;
    expect(await SelectHoist.extract(text, 'late', new Set(), true)).toEqual({ statement: text, decls: [] });
  });

  it('lifts every selection under the all policy, outermost only', async () => {
    const result = await SelectHoist.extract(
      `project(select(face().onPlane(select(face()))), box.sideFaces(0))`, 'all', new Set(), true,
    );
    expect(result.decls).toEqual([`const sel = select(face().onPlane(select(face())));`]);
    expect(result.statement).toBe(`project(sel, box.sideFaces(0))`);
  });

  it('records the names it allocates so later declarations never collide', async () => {
    const used = new Set<string>();
    await SelectHoist.extract(`loft(a, b).connect(select(edge()).end(), [0, 0, 0])`, 'late', used, true);
    expect([...used]).toEqual(['sel']);
  });
});
