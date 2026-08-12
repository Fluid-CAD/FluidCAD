import { describe, it, expect } from 'vitest';
import {
  applyAssemblyMateEdit,
  applyConnectorPropsEdit,
} from '../src/assembly-mate-edit.ts';

const HEADER = `import { insert, mate } from "fluidcad/core";\n`;

// The mate dialog's statement writer: `create` appends a canonical
// `mate(type, a.connectors.x, b.connectors.y)<chain>` statement, `edit`
// re-renders the statement at its source line from the dialog's full state.
describe('applyAssemblyMateEdit', () => {
  describe('create', () => {
    it('appends a bare mate referencing both const bindings', async () => {
      const code = `${HEADER}\nconst arm1 = insert(arm());\nconst base1 = insert(base()).grounded();\n`;
      const result = await applyAssemblyMateEdit(code, {
        create: {
          type: 'revolute',
          connectorA: { instanceLine: 3, connectorName: 'hinge' },
          connectorB: { instanceLine: 4, connectorName: 'pivot' },
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.newCode).toBe(
        `${HEADER}\nconst arm1 = insert(arm());\nconst base1 = insert(base()).grounded();\n\n`
        + `mate('revolute', arm1.connectors.hinge, base1.connectors.pivot);\n`,
      );
    });

    it('renders the full option chain in canonical order', async () => {
      const code = `${HEADER}\nconst a1 = insert(a());\nconst b1 = insert(b());\n`;
      const result = await applyAssemblyMateEdit(code, {
        create: {
          type: 'revolute',
          connectorA: { instanceLine: 3, connectorName: 'top' },
          connectorB: { instanceLine: 4, connectorName: 'top' },
          options: { flip: true, rotate: 30, offset: [0, 0, 5], limits: [0, 90] },
        },
      });
      expect(result.newCode).toContain(
        `mate('revolute', a1.connectors.top, b1.connectors.top).flip().rotate(30).offset(0, 0, 5).limits(0, 90);`,
      );
    });

    it('omits no-op options: flip false, rotate 0, zero offset', async () => {
      const code = `${HEADER}\nconst a1 = insert(a());\nconst b1 = insert(b());\n`;
      const result = await applyAssemblyMateEdit(code, {
        create: {
          type: 'fastened',
          connectorA: { instanceLine: 3, connectorName: 'top' },
          connectorB: { instanceLine: 4, connectorName: 'top' },
          options: { flip: false, rotate: 0, offset: [0, 0, 0], limits: null },
        },
      });
      expect(result.newCode).toContain(`mate('fastened', a1.connectors.top, b1.connectors.top);`);
    });

    it('groups a second mate directly under the first without a blank row', async () => {
      const code = `${HEADER}\nconst a1 = insert(a());\nconst b1 = insert(b());\n\n`
        + `mate('fastened', a1.connectors.top, b1.connectors.top);\n`;
      const result = await applyAssemblyMateEdit(code, {
        create: {
          type: 'planar',
          connectorA: { instanceLine: 3, connectorName: 'side' },
          connectorB: { instanceLine: 4, connectorName: 'side' },
        },
      });
      expect(result.newCode).toBe(
        `${HEADER}\nconst a1 = insert(a());\nconst b1 = insert(b());\n\n`
        + `mate('fastened', a1.connectors.top, b1.connectors.top);\n`
        + `mate('planar', a1.connectors.side, b1.connectors.side);\n`,
      );
    });

    it('binds a bare insert() expression statement to a fresh const', async () => {
      const code = `${HEADER}\ninsert(sidePlate());\nconst b1 = insert(b());\n`;
      const result = await applyAssemblyMateEdit(code, {
        create: {
          type: 'fastened',
          connectorA: { instanceLine: 3, connectorName: 'top' },
          connectorB: { instanceLine: 4, connectorName: 'top' },
        },
      });
      expect(result.newCode).toContain(`const sidePlate1 = insert(sidePlate());`);
      expect(result.newCode).toContain(`mate('fastened', sidePlate1.connectors.top, b1.connectors.top);`);
    });

    it('adds the mate import when missing', async () => {
      const code = `import { insert } from "fluidcad/core";\n\nconst a1 = insert(a());\nconst b1 = insert(b());\n`;
      const result = await applyAssemblyMateEdit(code, {
        create: {
          type: 'fastened',
          connectorA: { instanceLine: 3, connectorName: 'top' },
          connectorB: { instanceLine: 4, connectorName: 'top' },
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.newCode).toMatch(/import \{ *mate, *insert *\} from "fluidcad\/core";/);
      expect(result.newCode).toContain(`mate('fastened', a1.connectors.top, b1.connectors.top);`);
    });

    it('refuses when the addressed line has no insert()', async () => {
      const code = `${HEADER}\nconst a1 = insert(a());\nconst s = sketch(() => {});\n`;
      const result = await applyAssemblyMateEdit(code, {
        create: {
          type: 'fastened',
          connectorA: { instanceLine: 3, connectorName: 'top' },
          connectorB: { instanceLine: 4, connectorName: 'top' },
        },
      });
      expect(result.error).toMatch(/not an insert\(\)/);
      expect(result.newCode).toBe(code);
    });

    it('refuses a self-mate', async () => {
      const code = `${HEADER}\nconst a1 = insert(a());\n`;
      const result = await applyAssemblyMateEdit(code, {
        create: {
          type: 'fastened',
          connectorA: { instanceLine: 3, connectorName: 'top' },
          connectorB: { instanceLine: 3, connectorName: 'top' },
        },
      });
      expect(result.error).toMatch(/mated to itself/);
    });

    it('allows two different connectors on the same instance', async () => {
      const code = `${HEADER}\nconst a1 = insert(a());\nconst b1 = insert(b());\n`;
      const result = await applyAssemblyMateEdit(code, {
        create: {
          type: 'fastened',
          connectorA: { instanceLine: 3, connectorName: 'top' },
          connectorB: { instanceLine: 3, connectorName: 'bottom' },
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.newCode).toContain(`mate('fastened', a1.connectors.top, a1.connectors.bottom);`);
    });

    it('refuses XY offsets on slider/cylindrical/planar mates', async () => {
      const code = `${HEADER}\nconst a1 = insert(a());\nconst b1 = insert(b());\n`;
      for (const type of ['slider', 'cylindrical', 'planar'] as const) {
        const result = await applyAssemblyMateEdit(code, {
          create: {
            type,
            connectorA: { instanceLine: 3, connectorName: 'top' },
            connectorB: { instanceLine: 4, connectorName: 'top' },
            options: { offset: [1, 0, 5] },
          },
        });
        expect(result.error).toMatch(/along Z/);
      }
    });

    it('refuses limits on non-slider/revolute mates and inverted ranges', async () => {
      const code = `${HEADER}\nconst a1 = insert(a());\nconst b1 = insert(b());\n`;
      const fastened = await applyAssemblyMateEdit(code, {
        create: {
          type: 'fastened',
          connectorA: { instanceLine: 3, connectorName: 'top' },
          connectorB: { instanceLine: 4, connectorName: 'top' },
          options: { limits: [0, 10] },
        },
      });
      expect(fastened.error).toMatch(/only supported on slider and revolute/);
      const inverted = await applyAssemblyMateEdit(code, {
        create: {
          type: 'slider',
          connectorA: { instanceLine: 3, connectorName: 'top' },
          connectorB: { instanceLine: 4, connectorName: 'top' },
          options: { limits: [10, 10] },
        },
      });
      expect(inverted.error).toMatch(/strictly less/);
    });

    it('refuses an invalid connector name', async () => {
      const code = `${HEADER}\nconst a1 = insert(a());\nconst b1 = insert(b());\n`;
      const result = await applyAssemblyMateEdit(code, {
        create: {
          type: 'fastened',
          connectorA: { instanceLine: 3, connectorName: 'not a name' },
          connectorB: { instanceLine: 4, connectorName: 'top' },
        },
      });
      expect(result.error).toMatch(/not a valid connector name/);
    });
  });

  describe('edit', () => {
    const CODE = `${HEADER}\nconst a1 = insert(a());\nconst b1 = insert(b());\n\n`
      + `mate('revolute', a1.connectors.top, b1.connectors.top).limits(0, 90);\n`;

    it('re-renders type and options in place', async () => {
      const result = await applyAssemblyMateEdit(CODE, {
        edit: {
          sourceLine: 6,
          type: 'slider',
          connectorA: { instanceLine: 3, connectorName: 'top' },
          connectorB: { instanceLine: 4, connectorName: 'top' },
          options: { offset: [0, 0, 12], limits: [0, 40] },
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.newCode).toBe(`${HEADER}\nconst a1 = insert(a());\nconst b1 = insert(b());\n\n`
        + `mate('slider', a1.connectors.top, b1.connectors.top).offset(0, 0, 12).limits(0, 40);\n`);
    });

    it('re-points a connector reference', async () => {
      const result = await applyAssemblyMateEdit(CODE, {
        edit: {
          sourceLine: 6,
          type: 'revolute',
          connectorA: { instanceLine: 3, connectorName: 'hinge' },
          connectorB: { instanceLine: 4, connectorName: 'top' },
          options: { limits: [0, 90] },
        },
      });
      expect(result.newCode).toContain(`mate('revolute', a1.connectors.hinge, b1.connectors.top).limits(0, 90);`);
    });

    it('drops options removed by the dialog', async () => {
      const result = await applyAssemblyMateEdit(CODE, {
        edit: {
          sourceLine: 6,
          type: 'revolute',
          connectorA: { instanceLine: 3, connectorName: 'top' },
          connectorB: { instanceLine: 4, connectorName: 'top' },
        },
      });
      expect(result.newCode).toContain(`mate('revolute', a1.connectors.top, b1.connectors.top);\n`);
      expect(result.newCode).not.toContain('.limits(');
    });

    it('refuses when the addressed line is not a mate()', async () => {
      const result = await applyAssemblyMateEdit(CODE, {
        edit: {
          sourceLine: 3,
          type: 'revolute',
          connectorA: { instanceLine: 3, connectorName: 'top' },
          connectorB: { instanceLine: 4, connectorName: 'top' },
        },
      });
      expect(result.error).toMatch(/no mate\(\) statement/);
      expect(result.newCode).toBe(CODE);
    });
  });
});

// Statements referencing insert() bindings inside an `assembly()` body must
// land INSIDE that body (before its return) — a file-end append would
// reference the binding from outside its closure and throw on render.
describe('scope-aware placement (assembly() bodies)', () => {
  const DEF = [
    `import { assembly, insert, mate } from "fluidcad/core";`,
    ``,
    `export const xAxis = (width = 100) => assembly('x-axis', () => {`,
    `    const rail = insert(beam(width)).grounded();`,
    `    const carriage = insert(beam(20));`,
    `    mate('slider', rail.connectors.top, carriage.connectors.top);`,
    `    return { rail, carriage };`,
    `});`,
    ``,
  ].join('\n');

  it('places a created mate inside the body, before the return', async () => {
    const result = await applyAssemblyMateEdit(DEF, {
      create: {
        type: 'fastened',
        connectorA: { instanceLine: 4, connectorName: 'end' },
        connectorB: { instanceLine: 5, connectorName: 'start' },
      },
    });
    expect(result.error).toBeUndefined();
    const statement = `    mate('fastened', rail.connectors.end, carriage.connectors.start);`;
    expect(result.newCode).toContain(statement);
    expect(result.newCode.indexOf(statement))
      .toBeLessThan(result.newCode.indexOf('return { rail, carriage };'));
  });

  it('refuses a mate across two different assembly bodies', async () => {
    const code = [
      `import { assembly, insert, mate } from "fluidcad/core";`,
      ``,
      `export const a = () => assembly('a', () => {`,
      `    const p1 = insert(x());`,
      `    return { p1 };`,
      `});`,
      `export const b = () => assembly('b', () => {`,
      `    const p2 = insert(x());`,
      `    return { p2 };`,
      `});`,
      ``,
    ].join('\n');
    const result = await applyAssemblyMateEdit(code, {
      create: {
        type: 'fastened',
        connectorA: { instanceLine: 4, connectorName: 'top' },
        connectorB: { instanceLine: 8, connectorName: 'top' },
      },
    });
    expect(result.error).toContain('different assembly bodies');
    expect(result.newCode).toBe(code);
  });

  it('keeps flat top-level files appending at the file end', async () => {
    const code = `${HEADER}\nconst arm1 = insert(arm());\nconst base1 = insert(base());\n`;
    const result = await applyAssemblyMateEdit(code, {
      create: {
        type: 'fastened',
        connectorA: { instanceLine: 3, connectorName: 'top' },
        connectorB: { instanceLine: 4, connectorName: 'top' },
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode.trimEnd().endsWith(
      `mate('fastened', arm1.connectors.top, base1.connectors.top);`,
    )).toBe(true);
  });
});

// The pen-button edit: rewrite a connector() statement's name and adjustment
// chain in the part file, keeping the source argument text verbatim.
describe('applyConnectorPropsEdit', () => {
  const PART = `import { part, connector, extrude } from "fluidcad/core";\n\n`
    + `part('arm', () => {\n`
    + `  const body = extrude(s, 10);\n`
    + `  connector('hinge', body.endFaces(0).center()).offset(0, 0, 2).rotate('x', 90);\n`
    + `});\n`;

  it('rewrites name and chain, keeping the source argument verbatim', async () => {
    const result = await applyConnectorPropsEdit(PART, {
      sourceLine: 5,
      name: 'pivot',
      rotate: { axis: 'z', angle: 180 },
      offset: [1, 0, 3],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `connector('pivot', body.endFaces(0).center()).offset(1, 0, 3).rotate('z', 180);`,
    );
  });

  it('drops the chain entirely for zero adjustments', async () => {
    const result = await applyConnectorPropsEdit(PART, {
      sourceLine: 5,
      name: 'hinge',
      rotate: null,
      offset: null,
    });
    expect(result.newCode).toContain(`connector('hinge', body.endFaces(0).center());`);
  });

  it('trims trailing zero offset components', async () => {
    const result = await applyConnectorPropsEdit(PART, {
      sourceLine: 5,
      name: 'hinge',
      rotate: null,
      offset: [4, 0, 0],
    });
    expect(result.newCode).toContain(`connector('hinge', body.endFaces(0).center()).offset(4);`);
  });

  it('refuses a non-connector line and a bad name', async () => {
    const wrongLine = await applyConnectorPropsEdit(PART, {
      sourceLine: 4, name: 'hinge', rotate: null, offset: null,
    });
    expect(wrongLine.error).toMatch(/no connector\(\) statement/);
    const badName = await applyConnectorPropsEdit(PART, {
      sourceLine: 5, name: 'not a name', rotate: null, offset: null,
    });
    expect(badName.error).toMatch(/not a valid connector name/);
  });
});
