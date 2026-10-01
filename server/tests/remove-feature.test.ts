import { describe, it, expect } from 'vitest';
import { RemoveFeature } from '../src/remove-feature.ts';
import { applyFeatureEdit } from '../src/apply-feature-edit/index.ts';

const HEADER = `import { sketch, circle, extrude, fillet, shell, plane, part, breakpoint } from "fluidcad/core";\n`
  + `import { diameter } from "fluidcad/constraints";\n`;

/** 1-based line of the first row containing `snippet`. */
function lineOf(code: string, snippet: string): number {
  const rows = code.split('\n');
  const row = rows.findIndex(r => r.includes(snippet));
  if (row < 0) {
    throw new Error(`fixture has no line containing ${snippet}`);
  }
  return row + 1;
}

async function analyze(code: string, snippet: string) {
  const captured = await RemoveFeature.capture(code, lineOf(code, snippet));
  if ('error' in captured) {
    throw new Error(captured.error);
  }
  return { spec: captured, analysis: await RemoveFeature.analyze(code, captured) };
}

async function remove(code: string, snippet: string): Promise<string> {
  const { spec } = await analyze(code, snippet);
  const result = await RemoveFeature.apply(code, spec);
  if (result.error) {
    throw new Error(result.error);
  }
  return result.newCode;
}

describe('RemoveFeature — dependants', () => {
  it('reports the chain of features referencing the removed binding, in source order', async () => {
    const code = `${HEADER}
const s = sketch('xy', () => {
  circle([0, 0], 10);
});
const e = extrude(s, 25);
const f = fillet(2, e.edges());
shell(f, 1);
const other = extrude(sketch('xz', () => { circle([0, 0], 5); }), 5);
`;
    const { analysis } = await analyze(code, 'const e = extrude');
    expect(analysis).toEqual({
      ok: true,
      dependents: [
        { name: 'f', line: lineOf(code, 'const f = fillet') },
        { name: 'shell', line: lineOf(code, 'shell(f') },
      ],
      connectors: [],
    });
  });

  it('pairs a sketch with the extrude that consumes it implicitly', async () => {
    const code = `${HEADER}
sketch('xy', () => {
  circle([0, 0], 10);
});
breakpoint();
extrude(25);
sketch('xz', () => {
  circle([0, 0], 5);
});
extrude(5);
`;
    const { analysis } = await analyze(code, "sketch('xy'");
    expect(analysis).toEqual({ ok: true, dependents: [{ name: 'extrude', line: lineOf(code, 'extrude(25)') }], connectors: [] });
  });

  it('has nothing to report for an unreferenced feature', async () => {
    const code = `${HEADER}
const s = sketch('xy', () => {
  circle([0, 0], 10);
});
const e = extrude(s, 25);
fillet(2, e.edges());
`;
    const { analysis } = await analyze(code, 'fillet(2');
    expect(analysis).toEqual({ ok: true, dependents: [], connectors: [] });
  });

  it('keeps a same-named binding in another part body out of the closure', async () => {
    const code = `${HEADER}
export const a = part('A', () => {
  const s = sketch('xy', () => { circle([0, 0], 10); });
  extrude(s, 25);
});
export const b = part('B', () => {
  const s = sketch('xy', () => { circle([0, 0], 5); });
  extrude(s, 5);
});
`;
    const { analysis } = await analyze(code, "const s = sketch('xy', () => { circle([0, 0], 10)");
    expect(analysis).toEqual({ ok: true, dependents: [{ name: 'extrude', line: lineOf(code, 'extrude(s, 25)') }], connectors: [] });
  });

  it('sketch geometry is silent: no dependants reported', async () => {
    const code = `${HEADER}
sketch('xy', () => {
  const c1 = circle([0, 0], 10);
  diameter(c1, 20);
});
`;
    const { analysis } = await analyze(code, 'const c1');
    expect(analysis).toEqual({ ok: true, dependents: [], connectors: [] });
  });

  it('refuses when the statement text drifted since the render', async () => {
    const code = `${HEADER}\nconst e = extrude(25);\n`;
    const spec = { statement: { line: lineOf(code, 'const e'), expectedText: 'const e = extrude(24);' } };
    const analysis = await RemoveFeature.analyze(code, spec);
    expect(analysis.ok).toBe(false);
  });
});

describe('RemoveFeature — apply', () => {
  it('deletes the feature and the whole closure', async () => {
    const code = `${HEADER}
const s = sketch('xy', () => {
  circle([0, 0], 10);
});
const e = extrude(s, 25);
const f = fillet(2, e.edges());
shell(f, 1);
const p = plane('xy', 10);
`;
    expect(await remove(code, 'const s = sketch')).toBe(`${HEADER}
const p = plane('xy', 10);
`);
  });

  it('deletes an implicitly consumed sketch with its extrude, leaving the next pair intact', async () => {
    const code = `${HEADER}
sketch('xy', () => {
  circle([0, 0], 10);
});
extrude(25);
sketch('xz', () => {
  circle([0, 0], 5);
});
extrude(5);
`;
    expect(await remove(code, "sketch('xy'")).toBe(`${HEADER}
sketch('xz', () => {
  circle([0, 0], 5);
});
extrude(5);
`);
  });

  it('deletes dependants inside a part body without touching the part', async () => {
    const code = `${HEADER}
const p = plane('xy', 10);
export const a = part('A', () => {
  const s = sketch(p, () => { circle([0, 0], 10); });
  extrude(s, 25);
  const t = sketch('xz', () => { circle([0, 0], 5); });
  extrude(t, 5);
});
`;
    expect(await remove(code, 'const p = plane')).toBe(`${HEADER}
export const a = part('A', () => {
  const t = sketch('xz', () => { circle([0, 0], 5); });
  extrude(t, 5);
});
`);
  });

  it('a sketch-body statement goes through the sketch sweep', async () => {
    const code = `${HEADER}
sketch('xy', () => {
  const c1 = circle([0, 0], 10);
  diameter(c1, 20);
});
extrude(25);
`;
    expect(await remove(code, 'const c1')).toBe(`${HEADER}
sketch('xy', () => {
});
extrude(25);
`);
  });
});

describe('RemoveFeature — orphaned selections', () => {
  const code = `${HEADER}
const a = sketch('xy', () => {
  circle([0, 0], 10);
});
const b = sketch(plane('xy', { offset: 40 }), () => {
  circle([0, 0], 5);
});
const keep = select(face());
const sel = select(edge().farthest('x'));
const sel2 = select(edge().nearest('x'));
const l = loft(a, b).connect(sel.end(), sel2.start());
fillet(2, l.edges(), keep);
shell(1, sel2);
`;

  it('does not list the selections a removed feature used as dependants', async () => {
    const { analysis } = await analyze(code, 'const l = loft');
    expect(analysis).toEqual({ ok: true, dependents: [{ name: 'fillet', line: lineOf(code, 'fillet(2') }], connectors: [] });
  });

  it('a sketchClosed rider rides the same round trip and writes the chain', async () => {
    const source = `const s = sketch('xy', () => {\n  line([0, 0], [10, 0]);\n});\n`;
    const closed = await applyFeatureEdit(source, {
      feature: 'sketch', filePath: '/ws/model.fluid.js', producers: [], parts: [], imports: [],
      sketchClosed: { sourceLine: 1, closed: true },
    });
    expect(closed.error).toBeUndefined();
    expect(closed.newCode).toBe(`const s = sketch('xy', () => {\n  line([0, 0], [10, 0]);\n}).close();\n`);
    const reopened = await applyFeatureEdit(closed.newCode, {
      feature: 'sketch', filePath: '/ws/model.fluid.js', producers: [], parts: [], imports: [],
      sketchClosed: { sourceLine: 1, closed: false },
    });
    expect(reopened.newCode).toBe(source);
  });

  it('the cascade takes the selections only the removed statements referenced', async () => {
    const { spec } = await analyze(code, 'const l = loft');
    const result = await applyFeatureEdit(code, {
      feature: 'sketch', filePath: '/ws/model.fluid.js', producers: [], parts: [], imports: [], removeFeature: spec,
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).not.toContain('const sel = ');
    expect(result.newCode).not.toContain('loft(');
    expect(result.newCode).not.toContain('fillet(');
    // `keep` lost its only consumer too; `sel2` still feeds the shell.
    expect(result.newCode).not.toContain('const keep');
    expect(result.newCode).toContain(`const sel2 = select(edge().nearest('x'));\nshell(1, sel2);`);
  });
});

// A connector copy that follows a repeat (`copy(holes, bolt)`) names the
// repeat by its binding, so removing the repeat — or the connector — takes
// the copy statement along, listed first.
describe('RemoveFeature — a copy that follows a repeat', () => {
  const FLANGE = `import { part, sketch, circle, extrude, cut, repeat, connector, copy } from "fluidcad/core";

export const flange = part('Flange', () => {
  sketch('xy', () => { circle([0, 0], 200); });
  const e = extrude(10);
  sketch(e.endFaces(), () => { circle([40, 0], 20); });
  const hole = cut();
  const holes = repeat('circular', 'z', { count: 6, angle: 360 }, hole);
  const bolt = connector('bolt', hole.startEdges());
  copy(holes, bolt);
});
`;

  it('lists the follow copy as the repeat\'s dependant and removes it with the repeat', async () => {
    const { analysis } = await analyze(FLANGE, 'const holes = repeat');
    expect(analysis).toEqual({ ok: true, dependents: [{ name: 'copy', line: lineOf(FLANGE, 'copy(holes') }], connectors: [] });

    const removed = await remove(FLANGE, 'const holes = repeat');
    expect(removed).not.toContain('repeat(');
    expect(removed).not.toContain('copy(holes');
    expect(removed).toContain(`  const bolt = connector('bolt', hole.startEdges());\n});`);
  });

  it('removes the follow copy with its connector, keeping the repeat', async () => {
    const removed = await remove(FLANGE, 'const bolt = connector');
    expect(removed).toContain(`  const holes = repeat('circular', 'z', { count: 6, angle: 360 }, hole);\n});`);
    expect(removed).not.toContain('copy(holes');
  });
});

// A hole placed on a face inside a part gets a connector of its own from the
// dialog, and a hole placed at an existing connector binds it to a name. The
// removal takes those along when nothing else reads them — silently: they
// are not dependants, nothing breaks if they stay.
describe('RemoveFeature — a hole\'s connectors', () => {
  const PLATE_HEADER = `import { part, sketch, circle, extrude, hole, connector, copy, select, fillet, insert, mate } from "fluidcad/core";\n`
    + `import { face } from "fluidcad/filters";\n`;

  /** A plate part whose body ends with `tail`, plus whatever follows the part. */
  function plate(tail: string, after = ''): string {
    return `${PLATE_HEADER}
export const plate = part('Plate', () => {
  sketch('xy', () => { circle([0, 0], 80); });
  const e = extrude(10);
${tail}
});
${after}`;
  }

  const OWN = `  const h1 = connector('h1', e.endFaces(0).center());\n  hole('M6', h1).clearance('close');`;

  it('reports the connector apart from the dependants and deletes it with the hole', async () => {
    const code = plate(OWN);
    const { analysis } = await analyze(code, "hole('M6'");
    expect(analysis).toEqual({
      ok: true,
      dependents: [],
      connectors: [{ name: 'h1', line: lineOf(code, 'const h1') }],
    });
    expect(await remove(code, "hole('M6'")).toBe(plate('').replace('const e = extrude(10);\n\n', 'const e = extrude(10);\n'));
  });

  it('deletes every connector the hole alone is placed at, chained ones included', async () => {
    const code = plate(
      `  const h1 = connector('h1', e.endFaces(0).center());\n`
      + `  const h2 = connector('h2', e.endFaces(0).center()).offset(20, 0, 0);\n`
      + `  const drilled = hole(5, h1, h2).depth(6, 118);`,
    );
    const removed = await remove(code, 'const drilled');
    expect(removed).not.toContain('connector(');
    expect(removed).not.toContain('hole(');
    expect(removed).toContain('const e = extrude(10);\n});');
  });

  it('keeps a connector another hole is placed at', async () => {
    const code = plate(`${OWN}\n  hole(3, h1).depth(4);`);
    const { analysis } = await analyze(code, "hole('M6'");
    expect(analysis).toEqual({ ok: true, dependents: [], connectors: [] });
    const removed = await remove(code, "hole('M6'");
    expect(removed).toContain(`  const h1 = connector('h1', e.endFaces(0).center());\n  hole(3, h1).depth(4);`);
  });

  it('keeps a connector a copy() patterns, and one the part hands out', async () => {
    const copied = plate(`${OWN}\n  copy('circular', 'z', { count: 6, angle: 360 }, h1);`);
    expect(await remove(copied, "hole('M6'")).toContain(`const h1 = connector('h1'`);

    const returned = plate(`${OWN}\n  return { h1 };`);
    expect(await remove(returned, "hole('M6'")).toContain(`const h1 = connector('h1'`);
  });

  it('keeps a connector a mate reads by name off an instance of the part', async () => {
    const code = plate(OWN, `const p1 = insert(plate);\nconst p2 = insert(plate);\nmate('fastened', p1.connectors.h1, p2.connectors['h1']);\n`);
    const { analysis } = await analyze(code, "hole('M6'");
    expect(analysis).toEqual({ ok: true, dependents: [], connectors: [] });
    expect(await remove(code, "hole('M6'")).toContain(`const h1 = connector('h1'`);
  });

  it('a same-named connector of another part does not keep it', async () => {
    const other = `const cover = part('Cover', () => {\n  const e = extrude(2);\n  connector('h1', e.endFaces(0).center());\n});\n`
      + `const c1 = insert(cover);\nconst c2 = insert(cover);\nmate('fastened', c1.connectors.h1, c2.connectors.h1);\n`;
    const code = plate(OWN, other);
    const removed = await remove(code, "hole('M6'");
    expect(removed).not.toContain(`const h1 = connector('h1'`);
    expect(removed).toContain(`connector('h1', e.endFaces(0).center());\n});\nconst c1`);
  });

  it('a read this cannot trace keeps the connector: a sub-assembly hop, a computed key', async () => {
    const hop = plate(OWN, `mate('fastened', occ.parts.plate.connectors.h1, base.connectors.top);\n`);
    expect(await remove(hop, "hole('M6'")).toContain(`const h1 = connector('h1'`);

    const computed = plate(OWN, `const p1 = insert(plate);\nconst frames = names.map((n) => p1.connectors[n]);\n`);
    expect(await remove(computed, "hole('M6'")).toContain(`const h1 = connector('h1'`);
  });

  it('leaves an exported connector and one the hole does not bind alone', async () => {
    const exported = `${PLATE_HEADER}\nexport const mount = connector('mount', [0, 0, 40]);\nhole(5, mount);\n`;
    expect(await remove(exported, 'hole(5')).toContain(`export const mount = connector('mount'`);

    const pair = plate(`  const h1 = connector('h1', e.endFaces(0).center()), h2 = connector('h2', e.startFaces(0).center());\n  hole(5, h1);`);
    expect(await remove(pair, 'hole(5')).toContain(`const h1 = connector('h1'`);
  });

  it('takes the connector of a hole that goes as a dependant', async () => {
    const code = plate(
      `  const pts = sketch(e.endFaces(), () => { circle([10, 0], 1); });\n`
      + `  const h1 = connector('h1', e.endFaces(0).center());\n`
      + `  hole('M4', pts.geometries.c.center(), h1);`,
    );
    const { analysis } = await analyze(code, 'const pts = sketch');
    expect(analysis).toEqual({
      ok: true,
      dependents: [{ name: 'hole', line: lineOf(code, "hole('M4'") }],
      connectors: [{ name: 'h1', line: lineOf(code, 'const h1') }],
    });
    const removed = await remove(code, 'const pts = sketch');
    expect(removed).toContain('const e = extrude(10);\n});');
  });

  it('a connector that names the removed feature is a dependant, not a companion', async () => {
    const code = plate(OWN);
    const { analysis } = await analyze(code, 'const e = extrude');
    expect(analysis).toEqual({
      ok: true,
      dependents: [
        { name: 'h1', line: lineOf(code, 'const h1') },
        { name: 'hole', line: lineOf(code, "hole('M6'") },
      ],
      connectors: [],
    });
  });

  it('does not touch a connector no removed hole is placed at', async () => {
    const code = plate(`  const tip = connector('tip', e.endFaces(0).center());\n  const f = fillet(1, e.endEdges());\n  hole(5, e.startFaces(0).center());`);
    expect(await remove(code, 'hole(5')).toContain(`const tip = connector('tip'`);
  });

  it('follows the chain: the selection only the connector read goes with it', async () => {
    const code = plate(`  const top = select(face().onPlane('xy', 10));\n  const h1 = connector('h1', top);\n  hole(5, h1);`);
    const { spec } = await analyze(code, 'hole(5');
    const result = await applyFeatureEdit(code, {
      feature: 'sketch', filePath: '/ws/plate.part.js', producers: [], parts: [], imports: [], removeFeature: spec,
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('const e = extrude(10);\n});');
  });

  it('takes only the connectors the spec lists', async () => {
    const code = plate(OWN);
    const { spec } = await analyze(code, "hole('M6'");
    const bare = await RemoveFeature.apply(code, { statement: spec.statement });
    expect(bare.newCode).toContain(`const h1 = connector('h1'`);
    expect(bare.newCode).not.toContain('hole(');
  });

  it('leaves a listed connector that gained a reader, or moved, since the capture', async () => {
    const code = plate(OWN);
    const { spec } = await analyze(code, "hole('M6'");

    const read = code.replace(`.clearance('close');`, `.clearance('close');\n  copy('circular', 'z', { count: 4, angle: 360 }, h1);`);
    const kept = await RemoveFeature.apply(read, spec);
    expect(kept.error).toBeUndefined();
    expect(kept.newCode).toContain(`const h1 = connector('h1'`);

    const edited = code.replace(`e.endFaces(0).center());`, `e.startFaces(0).center());`);
    const stale = await RemoveFeature.apply(edited, spec);
    expect(stale.error).toBeUndefined();
    expect(stale.newCode).toContain(`const h1 = connector('h1', e.startFaces(0).center());`);
    expect(stale.newCode).not.toContain('hole(');
  });

  it('capture drops the connectors another file reads', async () => {
    const code = plate(
      `  const h1 = connector('h1', e.endFaces(0).center());\n`
      + `  const h2 = connector('h2', e.startFaces(0).center());\n`
      + `  hole(5, h1, h2);`,
    );
    const captured = await RemoveFeature.capture(code, lineOf(code, 'hole(5'), async (connectors) => {
      expect(connectors.map((c) => [c.variable, c.owner])).toEqual([
        ['h1', { name: 'h1', definition: { localName: 'plate', exportName: 'plate' } }],
        ['h2', { name: 'h2', definition: { localName: 'plate', exportName: 'plate' } }],
      ]);
      return connectors.filter((c) => c.variable === 'h2');
    });
    if ('error' in captured) {
      throw new Error(captured.error);
    }
    expect(captured.connectors).toEqual([
      { line: lineOf(code, 'const h2'), expectedText: `const h2 = connector('h2', e.startFaces(0).center());` },
    ]);
    const removed = (await RemoveFeature.apply(code, captured)).newCode;
    expect(removed).toContain(`const h1 = connector('h1'`);
    expect(removed).not.toContain(`const h2`);
  });
});
