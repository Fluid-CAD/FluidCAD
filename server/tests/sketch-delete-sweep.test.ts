import { describe, it, expect } from 'vitest';
import { SketchDeleteSweep } from '../src/sketch-delete-sweep.ts';

const HEADER = `import { origin, circle, line, extrude, sketch, breakpoint } from "fluidcad/core";\n`
  + `import { diameter, coincident, horizontal, tangent, distance } from "fluidcad/constraints";\n`;

/** 1-based line of the first row containing `snippet`. */
function lineOf(code: string, snippet: string): number {
  const rows = code.split('\n');
  const row = rows.findIndex(r => r.includes(snippet));
  if (row < 0) {
    throw new Error(`fixture has no line containing ${snippet}`);
  }
  return row + 1;
}

describe('SketchDeleteSweep — deleting sketch geometry', () => {
  it('takes the constraints referencing the geometry along, and nothing after the sketch', async () => {
    const code = `${HEADER}
export const box = part("Box", () => {
  sketch('xy', () => {
    const c1 = circle([0, 0], 463.36);
    coincident(c1.center(), origin());
    diameter(c1, 80);

  });
  breakpoint();

  extrude(25);
});
`;
    const result = await SketchDeleteSweep.removeStatement(code, lineOf(code, 'const c1'));
    expect(result.newCode).toBe(`${HEADER}
export const box = part("Box", () => {
  sketch('xy', () => {

  });
  breakpoint();

  extrude(25);
});
`);
  });

  it('leaves other geometry and its constraints alone', async () => {
    const code = `${HEADER}
sketch('xy', () => {
  const c1 = circle([0, 0], 10);
  const c2 = circle([30, 0], 5);
  diameter(c1, 20);
  diameter(c2, 10);
  coincident(c2.center(), origin());
});
extrude(25);
`;
    const result = await SketchDeleteSweep.removeStatement(code, lineOf(code, 'const c1'));
    expect(result.newCode).toBe(`${HEADER}
sketch('xy', () => {
  const c2 = circle([30, 0], 5);
  diameter(c2, 10);
  coincident(c2.center(), origin());
});
extrude(25);
`);
  });

  it('sweeps geometry built from the deleted shape, then the constraints on that geometry', async () => {
    const code = `${HEADER}
sketch('xy', () => {
  const c1 = circle([0, 0], 10);
  const l = line(c1.center(), [40, 0]);
  const c2 = circle([50, 0], 5);
  horizontal(l);
  tangent(l, c2);
  diameter(c2, 10);
});
`;
    const result = await SketchDeleteSweep.removeStatement(code, lineOf(code, 'const c1'));
    expect(result.newCode).toBe(`${HEADER}
sketch('xy', () => {
  const c2 = circle([50, 0], 5);
  diameter(c2, 10);
});
`);
  });

  it('sweeps names bound by destructuring', async () => {
    const code = `${HEADER}
sketch('xy', () => {
  const [a, b] = twoLines([0, 0], [10, 0], [20, 0]);
  const c = circle([5, 5], 2);
  horizontal(a);
  tangent(b, c);
  diameter(c, 4);
});
`;
    const result = await SketchDeleteSweep.removeStatement(code, lineOf(code, 'const [a, b]'));
    expect(result.newCode).toBe(`${HEADER}
sketch('xy', () => {
  const c = circle([5, 5], 2);
  diameter(c, 4);
});
`);
  });

  it('does not mistake a property for a mention', async () => {
    const code = `${HEADER}
sketch('xy', () => {
  const c1 = circle([0, 0], 10);
  const c2 = circle(pts.c1, 5);
  diameter(c2, 10);
});
`;
    const result = await SketchDeleteSweep.removeStatement(code, lineOf(code, 'const c1'));
    expect(result.newCode).toBe(`${HEADER}
sketch('xy', () => {
  const c2 = circle(pts.c1, 5);
  diameter(c2, 10);
});
`);
  });

  it('deleting a constraint removes just that statement', async () => {
    const code = `${HEADER}
sketch('xy', () => {
  const c1 = circle([0, 0], 10);
  coincident(c1.center(), origin());
  diameter(c1, 20);
});
`;
    const result = await SketchDeleteSweep.removeStatement(code, lineOf(code, 'diameter(c1'));
    expect(result.newCode).toBe(`${HEADER}
sketch('xy', () => {
  const c1 = circle([0, 0], 10);
  coincident(c1.center(), origin());
});
`);
  });

  it('deleting unbound geometry removes just that statement', async () => {
    const code = `${HEADER}
sketch('xy', () => {
  circle([0, 0], 10);
  const c2 = circle([30, 0], 5);
  diameter(c2, 10);
});
`;
    const result = await SketchDeleteSweep.removeStatement(code, lineOf(code, 'circle([0, 0]'));
    expect(result.newCode).toBe(`${HEADER}
sketch('xy', () => {
  const c2 = circle([30, 0], 5);
  diameter(c2, 10);
});
`);
  });

  it('only sweeps the sketch the geometry lives in', async () => {
    const code = `${HEADER}
sketch('xy', () => {
  const c1 = circle([0, 0], 10);
  diameter(c1, 20);
});
sketch('xz', () => {
  const c1 = circle([0, 0], 10);
  diameter(c1, 20);
});
`;
    const result = await SketchDeleteSweep.removeStatement(code, lineOf(code, 'const c1'));
    expect(result.newCode).toBe(`${HEADER}
sketch('xy', () => {
});
sketch('xz', () => {
  const c1 = circle([0, 0], 10);
  diameter(c1, 20);
});
`);
  });

  it('a statement outside every sketch body is a plain removal', async () => {
    const code = `${HEADER}
const s = sketch('xy', () => {
  const c1 = circle([0, 0], 10);
});
const e = extrude(s, 25);
fillet(2, e.edges());
`;
    const result = await SketchDeleteSweep.removeStatement(code, lineOf(code, 'const e = extrude'));
    expect(result.newCode).toBe(`${HEADER}
const s = sketch('xy', () => {
  const c1 = circle([0, 0], 10);
});
fillet(2, e.edges());
`);
  });
});
