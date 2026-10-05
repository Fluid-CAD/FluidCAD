import { describe, expect, it } from 'vitest';
import { OrphanedSelections } from '../src/orphaned-selections.ts';

const HEAD = `const e = extrude(10);
const sel = select(edge().farthest('x'));
`;

describe('OrphanedSelections.sweep', () => {
  it('removes a selection whose last reference the edit removed', async () => {
    const before = `${HEAD}loft(a, b).connect(sel.end(), e.startEdges(0).start());\nshell(1);`;
    const after = `${HEAD}shell(1);`;
    expect(await OrphanedSelections.sweep(before, after)).toBe(`const e = extrude(10);\nshell(1);`);
  });

  it('keeps a selection another statement still references', async () => {
    const before = `${HEAD}loft(a, b).connect(sel.end(), [0, 0, 0]);\nfillet(2, sel);`;
    const after = `${HEAD}fillet(2, sel);`;
    expect(await OrphanedSelections.sweep(before, after)).toBe(after);
  });

  it('never touches a selection nothing referenced before the edit', async () => {
    const before = `${HEAD}loft(a, b);\nshell(1);`;
    const after = `${HEAD}shell(1);`;
    expect(await OrphanedSelections.sweep(before, after)).toBe(after);
  });

  it('follows the chain: a selection only an orphan referenced goes too', async () => {
    const head = `const base = select(face().onPlane('xy'));\nconst sel = select(edge().onPlane(base));\n`;
    const before = `${head}loft(a, b).connect(sel.end(), [0, 0, 0]);`;
    expect(await OrphanedSelections.sweep(before, `${head}shell(1);`)).toBe('shell(1);');
  });

  it('removes a selection a rewritten statement stopped referencing, inside a part body', async () => {
    const wrap = (body: string) => `part('P', () => {\n  const sel = select(edge());\n  ${body}\n});`;
    const before = wrap('loft(a, b).connect(sel.end(), [0, 0, 0]);');
    expect(await OrphanedSelections.sweep(before, wrap('loft(a, b);'))).toBe(`part('P', () => {\n  loft(a, b);\n});`);
  });

  it('resolves references through scopes: a same-named binding elsewhere is not a reference', async () => {
    const other = `part('Q', () => {\n  const sel = select(face());\n  fillet(1, sel);\n});`;
    const before = `const sel = select(edge());\nloft(a, b).connect(sel.end(), [0, 0, 0]);\n${other}`;
    const after = `const sel = select(edge());\n${other}`;
    expect(await OrphanedSelections.sweep(before, after)).toBe(other);
  });

  it('counts a shorthand property as a reference', async () => {
    const before = `${HEAD}loft(a, b).connect(sel.end(), [0, 0, 0]);\nconst out = { sel };`;
    const after = `${HEAD}const out = { sel };`;
    expect(await OrphanedSelections.sweep(before, after)).toBe(after);
  });

  it('leaves exported and chained declarations alone — they are not helper declarations', async () => {
    const head = `export const pick = select(edge());\nconst tip = select(edge()).end();\n`;
    const before = `${head}loft(a, b).connect(pick.end(), tip);`;
    expect(await OrphanedSelections.sweep(before, `${head}shell(1);`)).toBe(`${head}shell(1);`);
  });

  it('keeps the user\'s own unused twin when the edit orphans an identical declaration', async () => {
    const twin = `const sel = select(edge());`;
    const scoped = (body: string) => `part('P', () => {\n  ${twin}\n${body}});`;
    const before = `${twin}\n${scoped('  loft(a, b).connect(sel.end(), [0, 0, 0]);\n')}`;
    const after = `${twin}\n${scoped('')}`;
    expect(await OrphanedSelections.sweep(before, after)).toBe(`${twin}\npart('P', () => {\n});`);
  });
});
