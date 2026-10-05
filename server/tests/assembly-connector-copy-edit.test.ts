import { describe, it, expect } from 'vitest';
import {
  AssemblyConnectorCopyEdit,
  type AssemblyConnectorCopyPayload,
} from '../src/assembly-connector-copy-edit.ts';
import { applyFeatureEdit } from '../src/apply-feature-edit/index.ts';

// The assembly Copy dialog's write (connector copies stage 3): a
// `copy('linear' | 'circular', …)` of the assembly's own connectors —
// addressed by their connector() statements' lines, each written as its
// const binding (hoisted onto a bare statement), a connector axis as its
// binding or `bay.instance(k)` — appended at the end of the connectors'
// scope, re-rendered in place, or removed with the delete sweep.

const HEADER = `import { insert, mate, connector } from "fluidcad/core";\n`;
const HEADER_COPY = `import { copy, insert, mate, connector } from "fluidcad/core";\n`;

/** 1-based line of the first row containing `snippet`. */
function lineOf(code: string, snippet: string): number {
  const rows = code.split('\n');
  const row = rows.findIndex(r => r.includes(snippet));
  if (row < 0) {
    throw new Error(`fixture has no line containing ${snippet}`);
  }
  return row + 1;
}

/** A rack: a grounded frame, a card, the `bay` slot and a `pivot`. */
const RACK = `${HEADER}
const frame = insert(rackFrame).grounded();
const card = insert(cardPart);
const bay = connector('bay', [0, 0, 20]);
const pivot = connector('pivot', [100, 0, 0]);
mate('slider', bay, card.connectors.edge);
`;

function target(code: string, name: string) {
  return { kind: 'connector' as const, connectorLine: lineOf(code, `connector('${name}'`), connectorName: name };
}

function linear(code: string, overrides: Partial<AssemblyConnectorCopyPayload> = {}): AssemblyConnectorCopyPayload {
  return {
    kind: 'linear',
    targets: [target(code, 'bay')],
    directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 4, value: 50 }],
    spacingMode: 'offset',
    ...overrides,
  };
}

describe('AssemblyConnectorCopyEdit — create', () => {
  it('appends the copy at the end of the file and imports copy', async () => {
    const result = await AssemblyConnectorCopyEdit.apply(RACK, { create: linear(RACK) });
    expect(result.error).toBeUndefined();
    expect(result.statement).toBe(`copy('linear', 'x', { count: 4, offset: 50 }, bay)`);
    expect(result.newCode).toBe(
      `${HEADER_COPY}${RACK.slice(HEADER.length)}copy('linear', 'x', { count: 4, offset: 50 }, bay);\n`,
    );
    expect(result.statementLine).toBe(lineOf(result.newCode, `copy('linear'`));
  });

  it('hoists a const named after a bare connector, and writes several targets in order', async () => {
    const code = `${HEADER}\nconnector('bay', [0, 0, 20]);\nconst dock = connector('dock', [0, 50, 20]);\n`;
    const result = await AssemblyConnectorCopyEdit.apply(code, {
      create: linear(code, { targets: [target(code, 'bay'), target(code, 'dock')] }),
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const bay = connector('bay', [0, 0, 20]);`);
    expect(result.newCode).toContain(`copy('linear', 'x', { count: 4, offset: 50 }, bay, dock);`);
  });

  it('turns around a connector axis — the connector, or one of its copies', async () => {
    const around = await AssemblyConnectorCopyEdit.apply(RACK, {
      create: {
        kind: 'circular',
        targets: [target(RACK, 'bay')],
        axis: { kind: 'connector', connectorLine: lineOf(RACK, `connector('pivot'`), connectorName: 'pivot' },
        count: 6,
        sweep: { mode: 'angle', value: 360 },
      },
    });
    expect(around.error).toBeUndefined();
    expect(around.newCode).toContain(`copy('circular', pivot, { count: 6, angle: 360 }, bay);`);

    const aroundCopy = await AssemblyConnectorCopyEdit.apply(RACK, {
      create: {
        kind: 'circular',
        targets: [target(RACK, 'bay')],
        axis: { kind: 'connector', connectorLine: lineOf(RACK, `connector('pivot'`), connectorName: 'pivot', slot: 1 },
        count: 3,
        sweep: { mode: 'offset', value: 45 },
        skip: [[2]],
      },
    });
    expect(aroundCopy.statement).toBe(`copy('circular', pivot.instance(1), { count: 3, offset: 45, skip: [2] }, bay)`);
  });

  it('writes two directions, centered and skipped cells', async () => {
    const result = await AssemblyConnectorCopyEdit.apply(RACK, {
      create: linear(RACK, {
        directions: [
          { axis: { kind: 'standard', axis: 'x' }, count: 3, value: 40 },
          { axis: { kind: 'standard', axis: 'y' }, count: 2, value: 'gap' },
        ],
        centered: true,
        skip: [[1, 1]],
      }),
    });
    expect(result.statement).toBe(
      `copy('linear', ['x', 'y'], { count: [3, 2], offset: [40, gap], centered: true, skip: [[1, 1]] }, bay)`,
    );
  });

  it('lands inside an assembly() body, before its return', async () => {
    const code = `${HEADER}\nexport const rack = assembly('rack', () => {\n  const bay = connector('bay', [0, 0, 20]);\n`
      + `  const card = insert(cardPart);\n  return { card };\n});\n`;
    const result = await AssemblyConnectorCopyEdit.apply(code, { create: linear(code) });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `  const card = insert(cardPart);\n\n  copy('linear', 'x', { count: 4, offset: 50 }, bay);\n  return { card };`,
    );
  });

  it('refuses a line that holds no connector()', async () => {
    const result = await AssemblyConnectorCopyEdit.apply(RACK, {
      create: linear(RACK, { targets: [{ kind: 'connector', connectorLine: lineOf(RACK, 'const card'), connectorName: 'bay' }] }),
    });
    expect(result.error).toMatch(/is not a connector\(\)/);
    expect(result.newCode).toBe(RACK);
  });

  it('lands declarations the dialog committed before the statement', async () => {
    const result = await applyFeatureEdit(RACK, {
      feature: 'sketch',
      filePath: '/ws/rack.assembly.js',
      producers: [],
      parts: [],
      imports: [],
      assemblyConnectorCopy: {
        create: linear(RACK, { directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 'n', value: 50 }] }),
      },
      newVariables: [{ name: 'n', initializer: '4' }],
    });
    expect(result.error).toBeUndefined();
    const rows = result.newCode.split('\n');
    const copyRow = rows.findIndex(r => r.startsWith(`copy('linear'`));
    expect(rows[copyRow]).toBe(`copy('linear', 'x', { count: n, offset: 50 }, bay);`);
    expect(rows[copyRow - 1]).toMatch(/^const n = 4;?$/);
  });
});

describe('AssemblyConnectorCopyEdit — edit', () => {
  const COPIED = `${RACK}copy('linear', 'x', { count: 4, offset: 50 }, bay);\n`;
  const copyLine = lineOf(COPIED, `copy('linear'`);

  it('re-renders the statement in place, keeping its axis and targets as written', async () => {
    const result = await AssemblyConnectorCopyEdit.apply(COPIED, {
      edit: {
        sourceLine: copyLine,
        kind: 'linear',
        targets: [{ kind: 'verbatim', sourceIndex: 0 }],
        directions: [{ axis: { kind: 'keep', sourceIndex: 0 }, count: 5, value: 50 }],
        spacingMode: 'offset',
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(`${RACK}copy('linear', 'x', { count: 5, offset: 50 }, bay);\n`);
    expect(result.statementLine).toBe(copyLine);
  });

  it('switches the kind and re-sources the axis and targets', async () => {
    const result = await AssemblyConnectorCopyEdit.apply(COPIED, {
      edit: {
        sourceLine: copyLine,
        kind: 'circular',
        targets: [target(COPIED, 'bay')],
        axis: { kind: 'connector', connectorLine: lineOf(COPIED, `connector('pivot'`), connectorName: 'pivot' },
        count: 4,
        sweep: { mode: 'angle', value: 360 },
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(`${RACK}copy('circular', pivot, { count: 4, angle: 360 }, bay);\n`);
  });

  it('keeps a binding in front of the call', async () => {
    const code = `${RACK}const bays = copy('linear', 'x', { count: 4, offset: 50 }, bay);\n`;
    const result = await AssemblyConnectorCopyEdit.apply(code, {
      edit: {
        sourceLine: lineOf(code, 'const bays'),
        ...linear(code, { directions: [{ axis: { kind: 'standard', axis: 'y' }, count: 2, value: 10 }] }),
      },
    });
    expect(result.newCode).toContain(`const bays = copy('linear', 'y', { count: 2, offset: 10 }, bay);`);
  });

  it('refuses a line that is no copy(), and a kept text the statement lacks', async () => {
    const notCopy = await AssemblyConnectorCopyEdit.apply(COPIED, {
      edit: { sourceLine: lineOf(COPIED, "mate('slider'"), ...linear(COPIED) },
    });
    expect(notCopy.error).toMatch(/is not a copy\(\)/);

    const stale = await AssemblyConnectorCopyEdit.apply(COPIED, {
      edit: { sourceLine: copyLine, ...linear(COPIED, { targets: [{ kind: 'verbatim', sourceIndex: 3 }] }) },
    });
    expect(stale.error).toMatch(/kept target no longer matches/);
    expect(stale.newCode).toBe(COPIED);
  });

  it('refuses a copy() that follows a repeat — that form is part-only', async () => {
    const code = `${RACK}copy(pivot, bay);\n`;
    const result = await AssemblyConnectorCopyEdit.apply(code, {
      edit: { sourceLine: lineOf(code, 'copy(pivot'), ...linear(code) },
    });
    expect(result.error).toBe(`the copy() on line ${lineOf(code, 'copy(pivot')} follows a repeat — that form is part-only`);
    expect(result.newCode).toBe(code);
  });
});

describe('AssemblyConnectorCopyEdit — remove', () => {
  it('removes the copy with every mate and replicate cell addressing its copies', async () => {
    const code = `${RACK}copy('linear', 'x', { count: 4, offset: 50 }, bay);\n`
      + `const card2 = insert(cardPart);\n`
      + `mate('slider', bay.instance(2), card2.connectors.edge);\n`
      + `replicate(card, [bay], [\n  [bay.instance(1)],\n  [bay.instance(3)],\n]);\n`;
    const result = await AssemblyConnectorCopyEdit.apply(code, { remove: { sourceLine: lineOf(code, `copy('linear'`) } });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(`${RACK}const card2 = insert(cardPart);\n`);
  });

  it('refuses a line that is no copy()', async () => {
    const result = await AssemblyConnectorCopyEdit.apply(RACK, { remove: { sourceLine: lineOf(RACK, 'const bay') } });
    expect(result.error).toMatch(/is not a copy\(\)/);
    expect(result.newCode).toBe(RACK);
  });
});

describe('AssemblyConnectorCopyEdit.validate', () => {
  it('takes exactly one of create, edit and remove', () => {
    expect(AssemblyConnectorCopyEdit.validate({})).toMatch(/exactly one of/);
    expect(AssemblyConnectorCopyEdit.validate({ create: linear(RACK), remove: { sourceLine: 3 } })).toMatch(/exactly one of/);
    expect(AssemblyConnectorCopyEdit.validate({ remove: { sourceLine: 0 } })).toMatch(/line its copy\(\) statement starts on/);
  });

  it('refuses a copy as a target, a twice-listed connector and kept entries outside an edit', () => {
    const bay = target(RACK, 'bay');
    expect(AssemblyConnectorCopyEdit.validate({ create: linear(RACK, { targets: [{ ...bay, slot: 1 } as never] }) }))
      .toMatch(/not copied again/);
    expect(AssemblyConnectorCopyEdit.validate({ create: linear(RACK, { targets: [bay, bay] }) }))
      .toMatch(/picked twice/);
    expect(AssemblyConnectorCopyEdit.validate({ create: linear(RACK, { targets: [{ kind: 'verbatim', sourceIndex: 0 }] }) }))
      .toMatch(/statement being edited/);
    expect(AssemblyConnectorCopyEdit.validate({
      create: linear(RACK, { directions: [{ axis: { kind: 'keep', sourceIndex: 0 }, count: 3, value: 10 }] }),
    })).toMatch(/statement being edited/);
  });

  it('refuses options a connector copy cannot take', () => {
    expect(AssemblyConnectorCopyEdit.validate({
      create: {
        kind: 'circular', targets: [target(RACK, 'bay')], axis: { kind: 'standard', axis: 'z' },
        count: 4, sweep: { mode: 'angle', value: 360 }, centered: true,
      },
    })).toMatch(/can't be centered/);
    expect(AssemblyConnectorCopyEdit.validate({
      create: linear(RACK, { directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 1, value: 10 }] }),
    })).toMatch(/at least 2/);
    expect(AssemblyConnectorCopyEdit.validate({
      create: linear(RACK, { directions: [{ axis: { kind: 'connector', connectorLine: 5, connectorName: 'pivot', slot: -1 }, count: 3, value: 10 }] }),
    })).toMatch(/slot must be a non-negative integer/);
    expect(AssemblyConnectorCopyEdit.validate({ create: linear(RACK, { skip: [[1, 2]] }) }))
      .toMatch(/skip entry/);
  });
});
