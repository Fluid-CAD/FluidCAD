import { describe, it, expect } from 'vitest';
import { removeStatementWithAssemblySweep } from '../src/assembly-delete-sweep.ts';
import { removeStatement } from '../src/code-editor/index.ts';

const HEADER = `import { insert, mate, connector } from "fluidcad/core";\n`;

/** 1-based line of the first row containing `snippet`. */
function lineOf(code: string, snippet: string): number {
  const rows = code.split('\n');
  const row = rows.findIndex(r => r.includes(snippet));
  if (row < 0) {
    throw new Error(`fixture has no line containing ${snippet}`);
  }
  return row + 1;
}

// The engine: one crank, two bores, one piston sub-assembly mated by a
// slider (bore) and a revolute (crank pin).
const ENGINE = `${HEADER}
const crank = insert(crankShaft);
const bore1 = connector('bore1', [0, 159, 157.2]);
const bore2 = connector('bore2', [0, 273, 157.2]);
const cyl1 = insert(pistonAssembly);
mate('slider', bore1, cyl1.parts.piston1.connectors.c2);
mate('revolute', cyl1.parts.connectingRodCap1.connectors.c2, crank.connectors.c2);
`;

const REPLICATED = `${ENGINE}replicate(cyl1, [bore1, crank.connectors.c2], [
  [bore2, crank.connectors.c3],
]);
`;

const PREAMBLE = `${HEADER}\nconst crank = insert(crankShaft);\nconst bore1 = connector('bore1', [0, 159, 157.2]);\nconst bore2 = connector('bore2', [0, 273, 157.2]);\n`;

describe('removeStatementWithAssemblySweep — deleting a part', () => {
  it('deletes every mate that references the part, on either side', async () => {
    const code = `${ENGINE}const bracket = insert(bracketPart);\nmate('fastened', crank.connectors.c1, bracket.connectors.foot);\n`;
    const result = await removeStatementWithAssemblySweep(code, lineOf(code, 'const cyl1'));
    expect(result.newCode).toBe(
      `${PREAMBLE}const bracket = insert(bracketPart);\nmate('fastened', crank.connectors.c1, bracket.connectors.foot);\n`,
    );
  });

  it('deletes mates that reach the part through .parts chains and a const binding', async () => {
    const code = `${HEADER}\nconst base = insert(basePlate);\nconst arm = insert(armAssembly());\n`
      + `const hinge = mate('revolute', base.connectors.pivot, arm.parts.link.connectors.pin).limits(-45, 45);\n`
      + `mate('fastened', base.connectors.foot, arm.parts.link.connectors.tip);\n`;
    const result = await removeStatementWithAssemblySweep(code, lineOf(code, 'const arm'));
    expect(result.newCode).toBe(`${HEADER}\nconst base = insert(basePlate);\n`);
  });

  it('sweeps mates in a nested assembly body too', async () => {
    const code = `${HEADER}\nconst base = insert(basePlate);\n`
      + `const sub = assembly('sub', () => {\n  const wheel = insert(wheelPart);\n  mate('revolute', base.connectors.axle, wheel.connectors.hub);\n});\n`;
    const result = await removeStatementWithAssemblySweep(code, lineOf(code, 'const wheel'));
    expect(result.newCode).toBe(`${HEADER}\nconst base = insert(basePlate);\nconst sub = assembly('sub', () => {\n});\n`);
  });

  it('leaves mates between other parts alone', async () => {
    const code = `${ENGINE}const bracket = insert(bracketPart);\nmate('fastened', crank.connectors.c1, bracket.connectors.foot);\n`;
    const result = await removeStatementWithAssemblySweep(code, lineOf(code, 'const bracket'));
    expect(result.newCode).toBe(ENGINE);
  });

  it('deleting the seed insert also deletes its mates and every replicate of it', async () => {
    const code = `${REPLICATED}replicate(cyl1, [bore1], [\n  [bore2],\n]);\nconst other = insert(bracket);\n`;
    const result = await removeStatementWithAssemblySweep(code, lineOf(code, 'const cyl1'));
    expect(result.newCode).toBe(`${PREAMBLE}const other = insert(bracket);\n`);
  });

  it('drops the replicate column and row cells that point at the deleted part', async () => {
    // Deleting the crank: its mate goes, and with it the crank column of
    // cyl1's replicate (via the mate branch), leaving the bore column.
    const result = await removeStatementWithAssemblySweep(REPLICATED, lineOf(REPLICATED, 'const crank'));
    expect(result.newCode).toBe(
      `${HEADER}\nconst bore1 = connector('bore1', [0, 159, 157.2]);\nconst bore2 = connector('bore2', [0, 273, 157.2]);\n`
      + `const cyl1 = insert(pistonAssembly);\nmate('slider', bore1, cyl1.parts.piston1.connectors.c2);\n`
      + `replicate(cyl1, [bore1], [\n  [bore2],\n]);\n`,
    );
  });

  it('drops replicate rows that point at the deleted part and removes an emptied replicate', async () => {
    const code = `${ENGINE}const crank2 = insert(crankShaft);\n`
      + `replicate(cyl1, [crank.connectors.c2], [\n  [crank.connectors.c3],\n  [crank2.connectors.c2],\n]);\n`
      + `replicate(cyl1, [crank.connectors.c2], [\n  [crank2.connectors.c3],\n]);\n`;
    const result = await removeStatementWithAssemblySweep(code, lineOf(code, 'const crank2'));
    expect(result.newCode).toBe(
      `${ENGINE}replicate(cyl1, [crank.connectors.c2], [\n  [crank.connectors.c3],\n]);\n`,
    );
  });

  it('sweeps mates on replicas of the deleted part through the replicate binding', async () => {
    const code = `${ENGINE}const sensor = insert(sensorBracket);\n`
      + `const [cyl2] = replicate(cyl1, [crank.connectors.c2], [\n  [crank.connectors.c3],\n]);\n`
      + `mate('fastened', sensor.connectors.foot, cyl2.parts.piston1.connectors.top);\n`
      + `mate('fastened', sensor.connectors.back, crank.connectors.c1);\n`;
    const result = await removeStatementWithAssemblySweep(code, lineOf(code, 'const cyl1'));
    expect(result.newCode).toBe(
      `${PREAMBLE}const sensor = insert(sensorBracket);\n`
      + `mate('fastened', sensor.connectors.back, crank.connectors.c1);\n`,
    );
  });

  it('trims a destructured row binding and sweeps the mates that used it', async () => {
    const code = `${ENGINE}const crank2 = insert(crankShaft);\nconst sensor = insert(sensorBracket);\n`
      + `const [cyl2, cyl3] = replicate(cyl1, [crank.connectors.c2], [\n  [crank.connectors.c3],\n  [crank2.connectors.c2],\n]);\n`
      + `mate('fastened', sensor.connectors.foot, cyl3.parts.piston1.connectors.top);\n`
      + `mate('fastened', sensor.connectors.back, cyl2.parts.piston1.connectors.top);\n`;
    const result = await removeStatementWithAssemblySweep(code, lineOf(code, 'const crank2'));
    expect(result.newCode).toBe(
      `${ENGINE}const sensor = insert(sensorBracket);\n`
      + `const [cyl2] = replicate(cyl1, [crank.connectors.c2], [\n  [crank.connectors.c3],\n]);\n`
      + `mate('fastened', sensor.connectors.back, cyl2.parts.piston1.connectors.top);\n`,
    );
  });

  it('is plain removeStatement for files without mate() or replicate()', async () => {
    const code = `${HEADER}\nconst crank = insert(crankShaft);\nconst cyl1 = insert(pistonAssembly);\n`;
    const swept = await removeStatementWithAssemblySweep(code, lineOf(code, 'const cyl1'));
    const plain = await removeStatement(code, lineOf(code, 'const cyl1'));
    expect(swept.newCode).toBe(plain.newCode);
  });
});

describe('removeStatementWithAssemblySweep — deleting a mate', () => {
  it('drops its column from targets and every row of the seed\'s replicate', async () => {
    const result = await removeStatementWithAssemblySweep(REPLICATED, lineOf(REPLICATED, "mate('slider'"));
    expect(result.newCode).toBe(
      `${PREAMBLE}const cyl1 = insert(pistonAssembly);\nmate('revolute', cyl1.parts.connectingRodCap1.connectors.c2, crank.connectors.c2);\n`
      + `replicate(cyl1, [crank.connectors.c2], [\n  [crank.connectors.c3],\n]);\n`,
    );
  });

  it('removes a replicate whose only column was the deleted mate\'s target', async () => {
    const code = `${ENGINE}replicate(cyl1, [crank.connectors.c2], [\n  [crank.connectors.c3],\n]);\n`;
    const result = await removeStatementWithAssemblySweep(code, lineOf(code, "mate('revolute'"));
    expect(result.newCode).toBe(
      `${PREAMBLE}const cyl1 = insert(pistonAssembly);\nmate('slider', bore1, cyl1.parts.piston1.connectors.c2);\n`,
    );
  });

  it('leaves replicates alone when the deleted mate did not target a column', async () => {
    const code = `${REPLICATED}mate('fastened', cyl1.parts.piston1.connectors.top, crank.connectors.c1);\n`;
    const result = await removeStatementWithAssemblySweep(code, lineOf(code, "mate('fastened'"));
    expect(result.newCode).toBe(REPLICATED);
  });

  it('matches a deleted mate\'s target across both index spellings', async () => {
    const code = `${HEADER}\nconst bank = insert(cylinderBank());\nconst sensor = insert(sensorBracket);\n`
      + `mate('fastened', sensor.connectors.foot, bank.parts.copies.0.connectors.top);\n`
      + `replicate(sensor, [bank.parts.copies[0].connectors.top], [\n  [bank.parts.copies[1].connectors.top],\n]);\n`;
    const result = await removeStatementWithAssemblySweep(code, lineOf(code, "mate('fastened'"));
    expect(result.newCode).toBe(`${HEADER}\nconst bank = insert(cylinderBank());\nconst sensor = insert(sensorBracket);\n`);
  });
});

describe('removeStatementWithAssemblySweep — orphaned replica bindings', () => {
  it('deleting a mate that empties a replicate also sweeps mates on its replicas', async () => {
    const code = `${ENGINE}const sensor = insert(sensorBracket);\n`
      + `const [cyl2] = replicate(cyl1, [crank.connectors.c2], [\n  [crank.connectors.c3],\n]);\n`
      + `mate('fastened', sensor.connectors.foot, cyl2.parts.piston1.connectors.top);\n`
      + `mate('fastened', sensor.connectors.back, crank.connectors.c1);\n`;
    const result = await removeStatementWithAssemblySweep(code, lineOf(code, "mate('revolute'"));
    expect(result.newCode).toBe(
      `${PREAMBLE}const cyl1 = insert(pistonAssembly);\nmate('slider', bore1, cyl1.parts.piston1.connectors.c2);\n`
      + `const sensor = insert(sensorBracket);\n`
      + `mate('fastened', sensor.connectors.back, crank.connectors.c1);\n`,
    );
  });
});

// Assembly connectors and their copies (connector copies D11, B8): deleting
// a connector() takes what names its binding — mates, replicate cells, the
// copy() statements that copy it or turn around it — and deleting a copy()
// takes what calls .instance() on one of its connectors.

const RACK_HEADER = `import { copy, insert, mate, connector } from "fluidcad/core";\n`;

const RACK = `${RACK_HEADER}
const card = insert(cardPart);
const bay = connector('bay', [0, 0, 20]);
const pivot = connector('pivot', [100, 0, 0]);
`;

describe('removeStatementWithAssemblySweep — deleting an assembly connector (B8)', () => {
  it('deletes the mates on it and drops the replicate cells naming it', async () => {
    const result = await removeStatementWithAssemblySweep(REPLICATED, lineOf(REPLICATED, 'const bore1'));
    expect(result.newCode).toBe(
      `${HEADER}\nconst crank = insert(crankShaft);\nconst bore2 = connector('bore2', [0, 273, 157.2]);\n`
      + `const cyl1 = insert(pistonAssembly);\n`
      + `mate('revolute', cyl1.parts.connectingRodCap1.connectors.c2, crank.connectors.c2);\n`
      + `replicate(cyl1, [crank.connectors.c2], [\n  [crank.connectors.c3],\n]);\n`,
    );
  });

  it('deletes its copy() and the mates on its copies', async () => {
    const code = `${RACK}copy('linear', 'x', { count: 4, offset: 50 }, bay);\n`
      + `mate('slider', bay.instance(2), card.connectors.edge);\n`
      + `mate('fastened', pivot, card.connectors.top);\n`;
    const result = await removeStatementWithAssemblySweep(code, lineOf(code, 'const bay'));
    expect(result.newCode).toBe(
      `${RACK_HEADER}\nconst card = insert(cardPart);\nconst pivot = connector('pivot', [100, 0, 0]);\n`
      + `mate('fastened', pivot, card.connectors.top);\n`,
    );
  });

  it('drops it from a copy() of several connectors, which keeps copying the others', async () => {
    const code = `${RACK}const dock = connector('dock', [0, 50, 20]);\n`
      + `copy('linear', 'x', { count: 3, offset: 40 }, bay, dock);\n`
      + `mate('slider', dock.instance(1), card.connectors.edge);\n`;
    const result = await removeStatementWithAssemblySweep(code, lineOf(code, 'const bay'));
    expect(result.newCode).toBe(
      `${RACK_HEADER}\nconst card = insert(cardPart);\nconst pivot = connector('pivot', [100, 0, 0]);\n`
      + `const dock = connector('dock', [0, 50, 20]);\n`
      + `copy('linear', 'x', { count: 3, offset: 40 }, dock);\n`
      + `mate('slider', dock.instance(1), card.connectors.edge);\n`,
    );
  });

  it('deletes a copy() turning around it, with the mates on that copy\'s copies — not on its connector', async () => {
    const code = `${RACK}copy('circular', pivot, { count: 4, angle: 360 }, bay);\n`
      + `mate('slider', bay.instance(1), card.connectors.edge);\n`
      + `mate('fastened', bay, card.connectors.top);\n`;
    const result = await removeStatementWithAssemblySweep(code, lineOf(code, 'const pivot'));
    expect(result.newCode).toBe(
      `${RACK_HEADER}\nconst card = insert(cardPart);\nconst bay = connector('bay', [0, 0, 20]);\n`
      + `mate('fastened', bay, card.connectors.top);\n`,
    );
  });

  it('sweeps its copy() in a file with no mate() or replicate() at all', async () => {
    const code = `${RACK}copy('linear', 'x', { count: 4, offset: 50 }, bay);\n`;
    const result = await removeStatementWithAssemblySweep(code, lineOf(code, 'const bay'));
    expect(result.newCode).toBe(
      `${RACK_HEADER}\nconst card = insert(cardPart);\nconst pivot = connector('pivot', [100, 0, 0]);\n`,
    );
  });

  it('is plain removeStatement for an unbound connector()', async () => {
    const code = `${RACK}connector('spare', [0, 0, 0]);\ncopy('linear', 'x', { count: 4, offset: 50 }, bay);\n`;
    const swept = await removeStatementWithAssemblySweep(code, lineOf(code, "connector('spare'"));
    const plain = await removeStatement(code, lineOf(code, "connector('spare'"));
    expect(swept.newCode).toBe(plain.newCode);
  });
});

describe('removeStatementWithAssemblySweep — deleting a connector copy (D11)', () => {
  it('deletes every mate and replicate cell calling .instance() on its connector, keeping those on the connector', async () => {
    const code = `${RACK}copy('linear', 'x', { count: 4, offset: 50 }, bay);\n`
      + `const card2 = insert(cardPart);\n`
      + `mate('slider', bay, card.connectors.edge);\n`
      + `mate('slider', bay.instance( 2 ), card2.connectors.edge);\n`
      + `replicate(card, [bay], [\n  [bay.instance(1)],\n  [pivot],\n]);\n`;
    const result = await removeStatementWithAssemblySweep(code, lineOf(code, `copy('linear'`));
    expect(result.newCode).toBe(
      `${RACK}const card2 = insert(cardPart);\n`
      + `mate('slider', bay, card.connectors.edge);\n`
      + `replicate(card, [bay], [\n  [pivot],\n]);\n`,
    );
  });

  it('deletes a copy() turning around one of its copies, and that copy\'s own users', async () => {
    const code = `${RACK}copy('linear', 'y', { count: 2, offset: 40 }, pivot);\n`
      + `copy('circular', pivot.instance(1), { count: 2, angle: 360 }, bay);\n`
      + `mate('slider', bay.instance(1), card.connectors.edge);\n`
      + `mate('fastened', bay, card.connectors.top);\n`;
    const result = await removeStatementWithAssemblySweep(code, lineOf(code, `copy('linear'`));
    expect(result.newCode).toBe(`${RACK}mate('fastened', bay, card.connectors.top);\n`);
  });
});
