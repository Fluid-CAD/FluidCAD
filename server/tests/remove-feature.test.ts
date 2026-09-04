import { describe, it, expect } from 'vitest';
import { RemoveFeature } from '../src/remove-feature.ts';

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
    expect(analysis).toEqual({ ok: true, dependents: [{ name: 'extrude', line: lineOf(code, 'extrude(25)') }] });
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
    expect(analysis).toEqual({ ok: true, dependents: [] });
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
    expect(analysis).toEqual({ ok: true, dependents: [{ name: 'extrude', line: lineOf(code, 'extrude(s, 25)') }] });
  });

  it('sketch geometry is silent: no dependants reported', async () => {
    const code = `${HEADER}
sketch('xy', () => {
  const c1 = circle([0, 0], 10);
  diameter(c1, 20);
});
`;
    const { analysis } = await analyze(code, 'const c1');
    expect(analysis).toEqual({ ok: true, dependents: [] });
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
