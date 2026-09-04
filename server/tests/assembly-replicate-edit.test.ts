import { describe, it, expect } from 'vitest';
import {
  applyAssemblyReplicateEdit,
  removeReplicateRow,
  renderReplicateStatement,
  validateReplicatePayload,
} from '../src/assembly-replicate-edit.ts';
import { applyAssemblyMateEdit } from '../src/assembly-mate-edit.ts';

const HEADER = `import { insert, mate, connector } from "fluidcad/core";\n`;
/** The header after a replicate write added its import. */
const HEADER_R = `import { replicate, insert, mate, connector } from "fluidcad/core";\n`;

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

function enginePayload(code: string) {
  return {
    seed: { instanceLine: lineOf(code, 'const cyl1') },
    targets: [
      { connectorLine: lineOf(code, "connector('bore1'"), connectorName: 'bore1' },
      { instanceLine: lineOf(code, 'const crank'), connectorName: 'c2' },
    ],
    rows: [[
      { connectorLine: lineOf(code, "connector('bore2'"), connectorName: 'bore2' },
      { instanceLine: lineOf(code, 'const crank'), connectorName: 'c3' },
    ]],
  };
}

describe('applyAssemblyReplicateEdit — create', () => {
  it('lands directly after the seed\'s last mate and imports replicate', async () => {
    const result = await applyAssemblyReplicateEdit(ENGINE, { create: enginePayload(ENGINE) });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(
      `import { replicate, insert, mate, connector } from "fluidcad/core";\n`
      + ENGINE.slice(HEADER.length)
      + `replicate(cyl1, [bore1, crank.connectors.c2], [\n  [bore2, crank.connectors.c3],\n]);\n`,
    );
  });

  it('places after the last mate mentioning the seed, not after unrelated later mates', async () => {
    const code = `${ENGINE}const other = insert(bracket);\nmate('fastened', other.connectors.a, crank.connectors.c5);\n`;
    const result = await applyAssemblyReplicateEdit(code, { create: enginePayload(code) });
    expect(result.error).toBeUndefined();
    const rows = result.newCode.split('\n');
    const replicateRow = rows.findIndex(r => r.startsWith('replicate('));
    expect(rows[replicateRow - 1]).toContain("mate('revolute', cyl1");
    expect(rows[replicateRow + 3]).toBe('const other = insert(bracket);');
  });

  it('hoists a const onto a bare seed insert (which then has no mate to follow)', async () => {
    const code = `${HEADER}\nconst crank = insert(crankShaft);\ninsert(pistonAssembly);\n`
      + `mate('revolute', other.parts.cap.connectors.c2, crank.connectors.c2);\n`;
    const result = await applyAssemblyReplicateEdit(code, {
      create: {
        seed: { instanceLine: 4 },
        targets: [{ instanceLine: 3, connectorName: 'c2' }],
        rows: [[{ instanceLine: 3, connectorName: 'c3' }]],
      },
    });
    // A bare insert can't have a mate (mates need the binding), so the
    // refusal names the binding the hoist would have given it.
    expect(result.error).toBe('no mate() references pistonAssembly1 in its scope — mate it first, then replicate');
    expect(result.newCode).toBe(code);
  });

  it('renders multiple rows', async () => {
    const code = `${HEADER}\nconst crank = insert(crankShaft);\nconst cyl1 = insert(pistonAssembly);\n`
      + `mate('revolute', cyl1.parts.cap.connectors.c2, crank.connectors.c2);\n`;
    const result = await applyAssemblyReplicateEdit(code, {
      create: {
        seed: { instanceLine: 4 },
        targets: [{ instanceLine: 3, connectorName: 'c2' }],
        rows: [
          [{ instanceLine: 3, connectorName: 'c3' }],
          [{ instanceLine: 3, connectorName: 'c4' }],
        ],
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `replicate(cyl1, [crank.connectors.c2], [\n  [crank.connectors.c3],\n  [crank.connectors.c4],\n]);\n`,
    );
  });

  it('renders a row cell that reaches through another occurrence\'s export chain', async () => {
    const code = `${HEADER}\nconst block = insert(engineBlock());\nconst cyl1 = insert(pistonAssembly);\n`
      + `mate('slider', block.parts.bores.b1.connectors.axis, cyl1.parts.piston1.connectors.c2);\n`;
    const result = await applyAssemblyReplicateEdit(code, {
      create: {
        seed: { instanceLine: 4 },
        targets: [{ instanceLine: 3, connectorName: 'axis', viaParts: [['bores', 'b1']] }],
        rows: [[{ instanceLine: 3, connectorName: 'axis', viaParts: [['bores', 'b2']] }]],
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `replicate(cyl1, [block.parts.bores.b1.connectors.axis], [\n  [block.parts.bores.b2.connectors.axis],\n]);`,
    );
  });

  it('places inside an assembly() body at the body\'s indent', async () => {
    const code = `${HEADER}\nexport const bank = assembly('bank', () => {\n  const crank = insert(crankShaft);\n`
      + `  const cyl1 = insert(pistonAssembly);\n  mate('revolute', cyl1.parts.cap.connectors.c2, crank.connectors.c2);\n  return { cyl1 };\n});\n`;
    const result = await applyAssemblyReplicateEdit(code, {
      create: {
        seed: { instanceLine: 5 },
        targets: [{ instanceLine: 4, connectorName: 'c2' }],
        rows: [[{ instanceLine: 4, connectorName: 'c3' }]],
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `  mate('revolute', cyl1.parts.cap.connectors.c2, crank.connectors.c2);\n`
      + `  replicate(cyl1, [crank.connectors.c2], [\n    [crank.connectors.c3],\n  ]);\n  return { cyl1 };\n`,
    );
  });

  it('refuses a seed that has no mate yet', async () => {
    const code = `${HEADER}\nconst crank = insert(crankShaft);\nconst cyl1 = insert(pistonAssembly);\n`;
    const result = await applyAssemblyReplicateEdit(code, {
      create: {
        seed: { instanceLine: 4 },
        targets: [{ instanceLine: 3, connectorName: 'c2' }],
        rows: [[{ instanceLine: 3, connectorName: 'c3' }]],
      },
    });
    expect(result.error).toContain('no mate() references cyl1');
    expect(result.newCode).toBe(code);
  });

  it('refuses a seed line that is not an insert()', async () => {
    const result = await applyAssemblyReplicateEdit(ENGINE, {
      create: { ...enginePayload(ENGINE), seed: { instanceLine: lineOf(ENGINE, "mate('slider'") } },
    });
    expect(result.error).toContain('not an insert()');
  });
});

describe('validateReplicatePayload', () => {
  const seed = { instanceLine: 6 };
  const crankC2 = { instanceLine: 3, connectorName: 'c2' };

  it('requires matching row lengths', () => {
    expect(validateReplicatePayload({ seed, targets: [crankC2, { connectorLine: 4, connectorName: 'bore1' }], rows: [[crankC2]] }))
      .toBe('row 1 has 1 entry, expected 2 (one per target)');
  });

  it('requires a cell kind matching its column', () => {
    expect(validateReplicatePayload({ seed, targets: [crankC2], rows: [[{ instanceLine: 3, exposeName: 'g1' }]] }))
      .toBe('row 1, column 1 — expected a connector like the target, got exposed geometry');
    expect(validateReplicatePayload({ seed, targets: [{ instanceLine: 3, exposeName: 'g1' }], rows: [[crankC2]] }))
      .toBe('row 1, column 1 — expected exposed geometry like the target, got a connector');
  });

  it('accepts an assembly connector in a part-connector column and vice versa', () => {
    expect(validateReplicatePayload({ seed, targets: [crankC2], rows: [[{ connectorLine: 4, connectorName: 'bore1' }]] })).toBeNull();
  });

  it('refuses cells and targets on the seed itself, but not on its replicas', () => {
    expect(validateReplicatePayload({ seed, targets: [crankC2], rows: [[{ instanceLine: 6, connectorName: 'c2' }]] }))
      .toBe('row 1, column 1 — the replacement sits on the seed itself');
    expect(validateReplicatePayload({ seed, targets: [{ instanceLine: 6, connectorName: 'c2' }], rows: [[crankC2]] }))
      .toContain('target 1 sits on the seed itself');
    expect(validateReplicatePayload({ seed, targets: [crankC2], rows: [[{ instanceLine: 6, connectorName: 'c2', replicaRow: 0 }]] })).toBeNull();
  });

  it('requires at least one target and one row, and valid names', () => {
    expect(validateReplicatePayload({ seed, targets: [], rows: [] })).toContain('at least one target');
    expect(validateReplicatePayload({ seed, targets: [crankC2], rows: [] })).toContain('at least one replica row');
    expect(validateReplicatePayload({ seed, targets: [{ instanceLine: 3, connectorName: 'bad name' }], rows: [[crankC2]] }))
      .toContain('not a valid connector name');
  });
});

describe('applyAssemblyReplicateEdit — edit', () => {
  it('re-renders the statement in place, keeping an array binding', async () => {
    const code = REPLICATED.replace(HEADER, HEADER_R).replace('replicate(cyl1', 'const cyls = replicate(cyl1');
    const payload = enginePayload(code);
    payload.rows.push([
      { connectorLine: lineOf(code, "connector('bore2'"), connectorName: 'bore2' },
      { instanceLine: lineOf(code, 'const crank'), connectorName: 'c4' },
    ]);
    const result = await applyAssemblyReplicateEdit(code, {
      edit: { ...payload, sourceLine: lineOf(code, 'replicate(cyl1') },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(
      code.replace(
        `const cyls = replicate(cyl1, [bore1, crank.connectors.c2], [\n  [bore2, crank.connectors.c3],\n]);`,
        `const cyls = replicate(cyl1, [bore1, crank.connectors.c2], [\n  [bore2, crank.connectors.c3],\n  [bore2, crank.connectors.c4],\n]);`,
      ),
    );
  });

  it('keeps a destructuring binding and rewrites a single-line hand-written form', async () => {
    const code = `${ENGINE}const [cyl2] = replicate(cyl1, [crank.connectors.c2], [[crank.connectors.c3]]);\n`;
    const payload = {
      seed: { instanceLine: lineOf(code, 'const cyl1') },
      targets: [{ instanceLine: lineOf(code, 'const crank'), connectorName: 'c2' }],
      rows: [[{ instanceLine: lineOf(code, 'const crank'), connectorName: 'c5' }]],
    };
    const result = await applyAssemblyReplicateEdit(code, { edit: { ...payload, sourceLine: lineOf(code, 'const [cyl2]') } });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const [cyl2] = replicate(cyl1, [crank.connectors.c2], [\n  [crank.connectors.c5],\n]);\n`);
  });

  it('refuses an edit line that is not a replicate()', async () => {
    const result = await applyAssemblyReplicateEdit(REPLICATED, {
      edit: { ...enginePayload(REPLICATED), sourceLine: lineOf(REPLICATED, "mate('slider'") },
    });
    expect(result.error).toContain('not a replicate()');
  });
});

describe('removeReplicateRow', () => {
  const THREE = `${ENGINE}const [cyl2, cyl3, cyl4] = replicate(cyl1, [crank.connectors.c2], [\n  [crank.connectors.c3],\n  [crank.connectors.c4],\n  [crank.connectors.c5],\n]);\n`;

  it('splices a middle row and its destructured name', async () => {
    const result = await removeReplicateRow(THREE, lineOf(THREE, 'replicate(cyl1'), 1);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `const [cyl2, cyl4] = replicate(cyl1, [crank.connectors.c2], [\n  [crank.connectors.c3],\n  [crank.connectors.c5],\n]);\n`,
    );
  });

  it('refuses to drop a row whose name is referenced later', async () => {
    const code = `${THREE}mate('fastened', cyl3.parts.piston1.connectors.top, crank.connectors.c1);\n`;
    const result = await removeReplicateRow(code, lineOf(code, 'replicate(cyl1'), 1);
    expect(result.error).toBe(`cyl3 is used by the statement on line ${lineOf(code, "mate('fastened', cyl3")} — delete that statement first`);
  });

  it('removes the whole statement with its last row', async () => {
    const result = await removeReplicateRow(REPLICATED, lineOf(REPLICATED, 'replicate(cyl1'), 0);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(ENGINE);
  });

  it('refuses to remove a bound statement that is still referenced', async () => {
    const code = REPLICATED.replace('replicate(cyl1', 'const cyls = replicate(cyl1')
      + `mate('fastened', cyls[0].parts.piston1.connectors.top, crank.connectors.c1);\n`;
    const result = await removeReplicateRow(code, lineOf(code, 'replicate(cyl1'), 0);
    expect(result.error).toContain('cyls is used by the statement on line');
    expect(result.newCode).toBe(code);
  });

  it('refuses an out-of-range row', async () => {
    const result = await removeReplicateRow(REPLICATED, lineOf(REPLICATED, 'replicate(cyl1'), 3);
    expect(result.error).toContain('there is no row 4');
  });

  it('rides the assemblyReplicate side-channel', async () => {
    const result = await applyAssemblyReplicateEdit(THREE, { removeRow: { sourceLine: lineOf(THREE, 'replicate(cyl1'), row: 2 } });
    expect(result.newCode).toContain(`const [cyl2, cyl3] = replicate(cyl1, [crank.connectors.c2], [\n  [crank.connectors.c3],\n  [crank.connectors.c4],\n]);\n`);
  });
});

describe('mate writer — replicas and ordering', () => {
  it('places a new mate touching the seed BEFORE its replicate statement', async () => {
    const code = `${REPLICATED}const sensor = insert(sensorBracket);\n`;
    const result = await applyAssemblyMateEdit(code, {
      create: {
        type: 'fastened',
        connectorA: { instanceLine: lineOf(code, 'const sensor'), connectorName: 'foot' },
        connectorB: { instanceLine: lineOf(code, 'const cyl1'), connectorName: 'top', viaParts: [['piston1']] },
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(
      `${ENGINE}mate('fastened', sensor.connectors.foot, cyl1.parts.piston1.connectors.top);\n`
      + `replicate(cyl1, [bore1, crank.connectors.c2], [\n  [bore2, crank.connectors.c3],\n]);\n`
      + `const sensor = insert(sensorBracket);\n`,
    );
  });

  it('appends a mate that does not touch the seed after the replicate as usual', async () => {
    const code = `${REPLICATED}const sensor = insert(sensorBracket);\n`;
    const result = await applyAssemblyMateEdit(code, {
      create: {
        type: 'fastened',
        connectorA: { instanceLine: lineOf(code, 'const sensor'), connectorName: 'foot' },
        connectorB: { instanceLine: lineOf(code, 'const crank'), connectorName: 'c1' },
      },
    });
    expect(result.newCode.trimEnd().endsWith(`mate('fastened', sensor.connectors.foot, crank.connectors.c1);`)).toBe(true);
  });

  it('hoists a Replicas binding onto a bare replicate and indexes the row', async () => {
    const code = `${REPLICATED}const sensor = insert(sensorBracket);\n`;
    const result = await applyAssemblyMateEdit(code, {
      create: {
        type: 'fastened',
        connectorA: { instanceLine: lineOf(code, 'const sensor'), connectorName: 'foot' },
        connectorB: { instanceLine: lineOf(code, 'replicate(cyl1'), replicaRow: 0, connectorName: 'top', viaParts: [['piston1']] },
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('const cyl1Replicas = replicate(cyl1, [bore1, crank.connectors.c2], [');
    expect(result.newCode.trimEnd().endsWith(
      `mate('fastened', sensor.connectors.foot, cyl1Replicas[0].parts.piston1.connectors.top);`,
    )).toBe(true);
  });

  it('dedupes the hoisted name and reuses an existing array binding', async () => {
    const taken = REPLICATED.replace('const cyl1 = ', 'const cyl1Replicas = 3;\nconst cyl1 = ')
      + `const sensor = insert(sensorBracket);\n`;
    const hoisted = await applyAssemblyMateEdit(taken, {
      create: {
        type: 'fastened',
        connectorA: { instanceLine: lineOf(taken, 'const sensor'), connectorName: 'foot' },
        connectorB: { instanceLine: lineOf(taken, 'replicate(cyl1'), replicaRow: 0, connectorName: 'top' },
      },
    });
    expect(hoisted.newCode).toContain('const cyl1Replicas1 = replicate(cyl1');
    expect(hoisted.newCode).toContain('cyl1Replicas1[0].connectors.top');

    const bound = REPLICATED.replace('replicate(cyl1', 'const cyls = replicate(cyl1') + `const sensor = insert(sensorBracket);\n`;
    const reused = await applyAssemblyMateEdit(bound, {
      create: {
        type: 'fastened',
        connectorA: { instanceLine: lineOf(bound, 'const sensor'), connectorName: 'foot' },
        connectorB: { instanceLine: lineOf(bound, 'replicate(cyl1'), replicaRow: 0, connectorName: 'top' },
      },
    });
    expect(reused.newCode).toContain(`mate('fastened', sensor.connectors.foot, cyls[0].connectors.top);`);
  });

  it('renders a destructured replica by name, and refuses an unnamed slot', async () => {
    const code = `${ENGINE}const [cyl2, , cyl4] = replicate(cyl1, [crank.connectors.c2], [\n  [crank.connectors.c3],\n  [crank.connectors.c4],\n  [crank.connectors.c5],\n]);\nconst sensor = insert(sensorBracket);\n`;
    const byName = await applyAssemblyMateEdit(code, {
      create: {
        type: 'fastened',
        connectorA: { instanceLine: lineOf(code, 'const sensor'), connectorName: 'foot' },
        geometryA: undefined,
        connectorB: { instanceLine: lineOf(code, 'replicate(cyl1'), replicaRow: 2, connectorName: 'top', viaParts: [['piston1']] },
      },
    });
    expect(byName.error).toBeUndefined();
    expect(byName.newCode).toContain(`mate('fastened', sensor.connectors.foot, cyl4.parts.piston1.connectors.top);`);

    const hole = await applyAssemblyMateEdit(code, {
      create: {
        type: 'fastened',
        connectorA: { instanceLine: lineOf(code, 'const sensor'), connectorName: 'foot' },
        connectorB: { instanceLine: lineOf(code, 'replicate(cyl1'), replicaRow: 1, connectorName: 'top' },
      },
    });
    expect(hole.error).toContain('replica 2 of the replicate() on line');
  });

  it('refuses a replicaRow pointing at a non-replicate line', async () => {
    const code = `${REPLICATED}const sensor = insert(sensorBracket);\n`;
    const result = await applyAssemblyMateEdit(code, {
      create: {
        type: 'fastened',
        connectorA: { instanceLine: lineOf(code, 'const sensor'), connectorName: 'foot' },
        connectorB: { instanceLine: lineOf(code, 'const crank'), replicaRow: 0, connectorName: 'top' },
      },
    });
    expect(result.error).toContain('not a replicate()');
  });
});

describe('viaParts numeric keys (array exports)', () => {
  it('renders numeric export keys as index access on mate and replicate sides', async () => {
    const code = `${HEADER}\nconst bank = insert(cylinderBank());\nconst sensor = insert(sensorBracket);\n`
      + `mate('fastened', sensor.connectors.foot, bank.parts.copies[0].parts.piston1.connectors.top);\n`;
    const mate = await applyAssemblyMateEdit(code, {
      create: {
        type: 'fastened',
        connectorA: { instanceLine: 4, connectorName: 'foot' },
        connectorB: { instanceLine: 3, connectorName: 'top', viaParts: [['copies', '1'], ['piston1']] },
      },
    });
    expect(mate.error).toBeUndefined();
    expect(mate.newCode).toContain(`mate('fastened', sensor.connectors.foot, bank.parts.copies[1].parts.piston1.connectors.top);`);

    const leading = await applyAssemblyMateEdit(code, {
      create: {
        type: 'fastened',
        connectorA: { instanceLine: 4, connectorName: 'foot' },
        connectorB: { instanceLine: 3, connectorName: 'top', viaParts: [['2']] },
      },
    });
    expect(leading.newCode).toContain(`bank.parts[2].connectors.top);`);

    const replicated = await applyAssemblyReplicateEdit(code, {
      create: {
        seed: { instanceLine: 4 },
        targets: [{ instanceLine: 3, connectorName: 'top', viaParts: [['copies', '0'], ['piston1']] }],
        rows: [[{ instanceLine: 3, connectorName: 'top', viaParts: [['copies', '1'], ['piston1']] }]],
      },
    });
    expect(replicated.error).toBeUndefined();
    expect(replicated.newCode).toContain(
      `replicate(sensor, [bank.parts.copies[0].parts.piston1.connectors.top], [\n  [bank.parts.copies[1].parts.piston1.connectors.top],\n]);`,
    );
  });
});

describe('renderReplicateStatement', () => {
  it('indents continuation rows under the statement', () => {
    expect(renderReplicateStatement('s', ['a', 'b'], [['c', 'd']], '  ')).toBe(
      `replicate(s, [a, b], [\n    [c, d],\n  ]);`,
    );
  });
});
