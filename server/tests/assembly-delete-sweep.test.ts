import { describe, it, expect } from 'vitest';
import { removeStatementWithAssemblySweep } from '../src/assembly-delete-sweep.ts';
import { removeStatement } from '../src/code-editor.ts';

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
