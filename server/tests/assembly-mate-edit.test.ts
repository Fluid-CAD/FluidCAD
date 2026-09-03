import { describe, it, expect } from 'vitest';
import {
  applyAssemblyExportEdit,
  applyAssemblyMateEdit,
  applyConnectorPropsEdit,
  resolveExportKey,
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

  // Assembly-connector sides: `connector('name', [x, y, z])` statements
  // anchor and dereference exactly like insert() bindings — a bare
  // statement gets `const <name> = ` hoisted, preferring the connector's
  // own name.
  describe('assembly-connector sides', () => {
    it('writes the connector binding on either side', async () => {
      const code = `${HEADER}\nconst crank1 = insert(crank());\nconst hinge = connector('hinge', [40, 0, 12]).rotate('x', 90);\n`;
      const result = await applyAssemblyMateEdit(code, {
        create: {
          type: 'revolute',
          frameA: { connectorLine: 4, connectorName: 'hinge' },
          connectorB: { instanceLine: 3, connectorName: 'shaft' },
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.newCode).not.toMatch(/\borigin\b/);
      expect(result.newCode).toContain(`mate('revolute', hinge, crank1.connectors.shaft);`);

      const flipped = await applyAssemblyMateEdit(code, {
        create: {
          type: 'slider',
          connectorA: { instanceLine: 3, connectorName: 'shaft' },
          frameB: { connectorLine: 4, connectorName: 'hinge' },
        },
      });
      expect(flipped.newCode).toContain(`mate('slider', crank1.connectors.shaft, hinge);`);
    });

    it('hoists a const named after the connector onto a bare statement', async () => {
      const code = `${HEADER}\nconst c1 = insert(c());\nconnector('base', [0, 0, 0]);\n`;
      const result = await applyAssemblyMateEdit(code, {
        create: {
          type: 'fastened',
          frameA: { connectorLine: 4, connectorName: 'base' },
          connectorB: { instanceLine: 3, connectorName: 'top' },
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.newCode).toContain(`const base = connector('base', [0, 0, 0]);`);
      expect(result.newCode).toContain(`mate('fastened', base, c1.connectors.top);`);
    });

    it('falls back to a derived binding when the connector name is taken', async () => {
      const code = `${HEADER}\nconst base = insert(base());\nconnector('base', [0, 0, 0]);\n`;
      const result = await applyAssemblyMateEdit(code, {
        create: {
          type: 'fastened',
          frameA: { connectorLine: 4, connectorName: 'base' },
          connectorB: { instanceLine: 3, connectorName: 'top' },
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.newCode).toContain(`const base1 = connector('base', [0, 0, 0]);`);
      expect(result.newCode).toContain(`mate('fastened', base1, base.connectors.top);`);
    });

    it('edits a connector-sided mate in place', async () => {
      const code = `${HEADER}\nconst c1 = insert(c());\nconst pivot = connector('pivot', [0, 0, 10]);\n\n`
        + `mate('revolute', pivot, c1.connectors.shaft);\n`;
      const result = await applyAssemblyMateEdit(code, {
        edit: {
          sourceLine: 6,
          type: 'revolute',
          frameA: { connectorLine: 4, connectorName: 'pivot' },
          connectorB: { instanceLine: 3, connectorName: 'shaft' },
          options: { offset: [0, 40, 15] },
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.newCode).toContain(`mate('revolute', pivot, c1.connectors.shaft).offset(0, 40, 15);`);
    });

    it('refuses when the addressed line is not a connector()', async () => {
      const code = `${HEADER}\nconst c1 = insert(c());\nconst c2 = insert(c());\n`;
      const result = await applyAssemblyMateEdit(code, {
        create: {
          type: 'fastened',
          frameA: { connectorLine: 4, connectorName: 'base' },
          connectorB: { instanceLine: 3, connectorName: 'top' },
        },
      });
      expect(result.error).toMatch(/not a connector\(\)/);
      expect(result.newCode).toBe(code);
    });

    it('refuses both sides as assembly connectors', async () => {
      const result = await applyAssemblyMateEdit(`${HEADER}\n`, {
        create: {
          type: 'fastened',
          frameA: { connectorLine: 3, connectorName: 'a' },
          frameB: { connectorLine: 4, connectorName: 'b' },
        },
      });
      expect(result.error).toMatch(/both sides are assembly connectors/i);
    });

    it('refuses a connector side on a tangent mate and a bad ref', async () => {
      const tangent = await applyAssemblyMateEdit(`${HEADER}\n`, {
        create: {
          type: 'tangent',
          frameA: { connectorLine: 3, connectorName: 'a' },
          geometryB: { instanceLine: 3, exposeName: 'g1' },
        } as any,
      });
      expect(tangent.error).toMatch(/no surface to touch/i);
      const badName = await applyAssemblyMateEdit(`${HEADER}\nconst a1 = insert(a());\n`, {
        create: {
          type: 'fastened',
          frameA: { connectorLine: 4, connectorName: 'not valid' },
          connectorB: { instanceLine: 3, connectorName: 'top' },
        },
      });
      expect(badName.error).toMatch(/not a valid connector name/i);
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

  // An edit rewrites the statement WHERE IT IS — so every referenced binding
  // must be visible from that spot, unlike a create whose placement chases
  // its anchors into their scope.
  it('refuses re-pointing an edited mate at a binding inside an assembly body', async () => {
    const code = [
      `import { assembly, insert, mate } from "fluidcad/core";`,
      ``,
      `const arm1 = insert(arm());`,
      `const base1 = insert(base());`,
      `mate('fastened', arm1.connectors.top, base1.connectors.top);`,
      `export const sub = () => assembly('s', () => {`,
      `    const inner = insert(x());`,
      `    return { inner };`,
      `});`,
      ``,
    ].join('\n');
    const result = await applyAssemblyMateEdit(code, {
      edit: {
        sourceLine: 5,
        type: 'fastened',
        connectorA: { instanceLine: 3, connectorName: 'top' },
        connectorB: { instanceLine: 7, connectorName: 'top' },
      },
    });
    expect(result.error).toContain('different assembly body');
    expect(result.newCode).toBe(code);
  });

  it('lets an edited body mate keep referencing enclosing-scope bindings', async () => {
    const code = [
      `import { assembly, insert, mate } from "fluidcad/core";`,
      ``,
      `const shared = insert(base()).grounded();`,
      `export const sub = () => assembly('s', () => {`,
      `    const inner = insert(x());`,
      `    mate('fastened', inner.connectors.top, shared.connectors.top);`,
      `    return { inner };`,
      `});`,
      ``,
    ].join('\n');
    const result = await applyAssemblyMateEdit(code, {
      edit: {
        sourceLine: 6,
        type: 'fastened',
        connectorA: { instanceLine: 5, connectorName: 'top' },
        connectorB: { instanceLine: 3, connectorName: 'bottom' },
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `    mate('fastened', inner.connectors.top, shared.connectors.bottom);`,
    );
  });
});

// The pen-button edit: rewrite a connector() statement's name and adjustment
// chain in the part file, keeping the source argument text verbatim.
// The occurrence-aware mate flow's cross-file companion: make an insert()
// binding part of its assembly() body's return object.
describe('applyAssemblyExportEdit', () => {
  const ASM = `import { insert, assembly } from "fluidcad/core";\n\n`;

  it('adds the binding to an existing return object', async () => {
    const code = `${ASM}export const sub = assembly("sub", () => {\n  const a1 = insert(a());\n  const b1 = insert(b());\n  return { a1 };\n});\n`;
    const result = await applyAssemblyExportEdit(code, { insertLine: 5 });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('return { a1, b1 };');
  });

  it('appends a return when the body has none, before nothing else moves', async () => {
    const code = `${ASM}export const sub = assembly("sub", () => {\n  const a1 = insert(a());\n});\n`;
    const result = await applyAssemblyExportEdit(code, { insertLine: 4 });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('  const a1 = insert(a());\n  return { a1 };\n});');
  });

  it('auto-binds a bare insert and exports the fresh binding', async () => {
    const code = `${ASM}export const sub = assembly("sub", () => {\n  insert(rodCap());\n  return {};\n});\n`;
    const key = await resolveExportKey(code, 4);
    expect(key).toEqual({ name: 'rodCap1' });
    const result = await applyAssemblyExportEdit(code, { insertLine: 4 });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('const rodCap1 = insert(rodCap());');
    expect(result.newCode).toContain('return { rodCap1 };');
  });

  it('is a no-op when the binding is already exported (shorthand or pair)', async () => {
    const code = `${ASM}export const sub = assembly("sub", () => {\n  const a1 = insert(a());\n  return { left: a1, a1 };\n});\n`;
    const result = await applyAssemblyExportEdit(code, { insertLine: 4 });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(code);
  });

  it('extends a parenthesized return object', async () => {
    const code = `${ASM}export const sub = assembly("sub", () => {\n  const a1 = insert(a());\n  const b1 = insert(b());\n  return ({ a1 });\n});\n`;
    const result = await applyAssemblyExportEdit(code, { insertLine: 5 });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('return ({ a1, b1 });');
  });

  it('refuses a non-object return and a top-level insert', async () => {
    const nonObject = `${ASM}export const sub = assembly("sub", () => {\n  const a1 = insert(a());\n  return a1;\n});\n`;
    expect((await applyAssemblyExportEdit(nonObject, { insertLine: 4 })).error)
      .toMatch(/not an object literal/);
    const topLevel = `${ASM}const a1 = insert(a());\n`;
    expect((await applyAssemblyExportEdit(topLevel, { insertLine: 3 })).error)
      .toMatch(/needs no export/);
  });
});

// Occurrence-aware sides: `viaParts` levels render as `.parts.<keys...>`
// export-chain dereferences off the OCCURRENCE's insert binding.
describe('applyAssemblyMateEdit — viaParts sides', () => {
  it('renders a deep ref through one occurrence level', async () => {
    const code = `${HEADER}\nconst crank1 = insert(crank());\nconst piston1 = insert(pistonAssembly);\n`;
    const result = await applyAssemblyMateEdit(code, {
      create: {
        type: 'revolute',
        connectorA: { instanceLine: 4, connectorName: 'c2', viaParts: [['rodCap']] },
        connectorB: { instanceLine: 3, connectorName: 'c2' },
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `mate('revolute', piston1.parts.rodCap.connectors.c2, crank1.connectors.c2);`,
    );
  });

  it('renders nested object keys and multiple levels', async () => {
    const code = `${HEADER}\nconst g1 = insert(gantry);\nconst g2 = insert(gantry);\n`;
    const result = await applyAssemblyMateEdit(code, {
      create: {
        type: 'fastened',
        connectorA: { instanceLine: 3, connectorName: 'end', viaParts: [['left', 'axis'], ['carriage']] },
        connectorB: { instanceLine: 4, connectorName: 'end', viaParts: [[]] },
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `mate('fastened', g1.parts.left.axis.parts.carriage.connectors.end, g2.parts.connectors.end);`,
    );
  });

  it('allows same line + connector when the export chains differ, refuses when identical', async () => {
    const code = `${HEADER}\nconst g1 = insert(gantry);\n`;
    const differing = await applyAssemblyMateEdit(code, {
      create: {
        type: 'fastened',
        connectorA: { instanceLine: 3, connectorName: 'end', viaParts: [['left']] },
        connectorB: { instanceLine: 3, connectorName: 'end', viaParts: [['right']] },
      },
    });
    expect(differing.error).toBeUndefined();
    const identical = await applyAssemblyMateEdit(code, {
      create: {
        type: 'fastened',
        connectorA: { instanceLine: 3, connectorName: 'end', viaParts: [['left']] },
        connectorB: { instanceLine: 3, connectorName: 'end', viaParts: [['left']] },
      },
    });
    expect(identical.error).toMatch(/mated to itself/);
  });

  it('rejects an export key that is not an identifier', async () => {
    const code = `${HEADER}\nconst g1 = insert(gantry);\nconst c1 = insert(crank());\n`;
    const result = await applyAssemblyMateEdit(code, {
      create: {
        type: 'fastened',
        connectorA: { instanceLine: 3, connectorName: 'end', viaParts: [['not a key']] },
        connectorB: { instanceLine: 4, connectorName: 'end' },
      },
    });
    expect(result.error).toMatch(/not a valid export key/);
  });
});

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

// Tangent mates: geometry sides render through `.features.<name>`, the only
// option is `.noPropagate()`, and the per-type side-kind rule refuses every
// mismatched combination (17-mate-tangent §3.1/§7.2).
describe('applyAssemblyMateEdit — tangent', () => {
  const CODE = `${HEADER}\nconst cam1 = insert(cam());\nconst fol1 = insert(follower());\n`;

  it('appends a tangent mate referencing instance.features on both sides', async () => {
    const result = await applyAssemblyMateEdit(CODE, {
      create: {
        type: 'tangent',
        geometryA: { instanceLine: 3, exposeName: 'profile' },
        geometryB: { instanceLine: 4, exposeName: 'tip' },
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `mate('tangent', cam1.features.profile, fol1.features.tip);`,
    );
  });

  it('renders .noPropagate() only for an explicit false', async () => {
    const noProp = await applyAssemblyMateEdit(CODE, {
      create: {
        type: 'tangent',
        geometryA: { instanceLine: 3, exposeName: 'profile' },
        geometryB: { instanceLine: 4, exposeName: 'tip' },
        options: { propagate: false },
      },
    });
    expect(noProp.newCode).toContain(
      `mate('tangent', cam1.features.profile, fol1.features.tip).noPropagate();`,
    );
    const onByDefault = await applyAssemblyMateEdit(CODE, {
      create: {
        type: 'tangent',
        geometryA: { instanceLine: 3, exposeName: 'profile' },
        geometryB: { instanceLine: 4, exposeName: 'tip' },
        options: { propagate: true },
      },
    });
    expect(onByDefault.newCode).toContain(
      `mate('tangent', cam1.features.profile, fol1.features.tip);`,
    );
    expect(onByDefault.newCode).not.toContain('noPropagate');
  });

  it('refuses connector sides on tangent and geometry sides on other types', async () => {
    const connectorOnTangent = await applyAssemblyMateEdit(CODE, {
      create: {
        type: 'tangent',
        connectorA: { instanceLine: 3, connectorName: 'top' },
        connectorB: { instanceLine: 4, connectorName: 'top' },
      },
    });
    expect(connectorOnTangent.error).toMatch(/exposed geometry sides/);
    const geometryOnRevolute = await applyAssemblyMateEdit(CODE, {
      create: {
        type: 'revolute',
        geometryA: { instanceLine: 3, exposeName: 'profile' },
        geometryB: { instanceLine: 4, exposeName: 'tip' },
      },
    });
    expect(geometryOnRevolute.error).toMatch(/connector sides/);
  });

  it('refuses flip/rotate/offset/limits on tangent, and propagate elsewhere', async () => {
    const flipped = await applyAssemblyMateEdit(CODE, {
      create: {
        type: 'tangent',
        geometryA: { instanceLine: 3, exposeName: 'profile' },
        geometryB: { instanceLine: 4, exposeName: 'tip' },
        options: { flip: true },
      },
    });
    expect(flipped.error).toMatch(/no flip\/rotate\/offset\/limits/);
    const propagateOnRevolute = await applyAssemblyMateEdit(CODE, {
      create: {
        type: 'revolute',
        connectorA: { instanceLine: 3, connectorName: 'top' },
        connectorB: { instanceLine: 4, connectorName: 'top' },
        options: { propagate: false },
      },
    });
    expect(propagateOnRevolute.error).toMatch(/only applies to tangent/);
  });

  it('refuses a geometry self-mate; allows two exposures of one instance', async () => {
    const self = await applyAssemblyMateEdit(CODE, {
      create: {
        type: 'tangent',
        geometryA: { instanceLine: 3, exposeName: 'profile' },
        geometryB: { instanceLine: 3, exposeName: 'profile' },
      },
    });
    expect(self.error).toMatch(/cannot be mated to itself/);
    const twoExposures = await applyAssemblyMateEdit(CODE, {
      create: {
        type: 'tangent',
        geometryA: { instanceLine: 3, exposeName: 'profile' },
        geometryB: { instanceLine: 3, exposeName: 'rim' },
      },
    });
    expect(twoExposures.error).toBeUndefined();
    expect(twoExposures.newCode).toContain(
      `mate('tangent', cam1.features.profile, cam1.features.rim);`,
    );
  });

  it('edit re-renders a tangent statement in place', async () => {
    const code = `${CODE}\nmate('tangent', cam1.features.profile, fol1.features.tip);\n`;
    const result = await applyAssemblyMateEdit(code, {
      edit: {
        sourceLine: 6,
        type: 'tangent',
        geometryA: { instanceLine: 3, exposeName: 'profile' },
        geometryB: { instanceLine: 4, exposeName: 'tip' },
        options: { propagate: false },
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `mate('tangent', cam1.features.profile, fol1.features.tip).noPropagate();`,
    );
    expect(result.newCode.match(/mate\(/g)).toHaveLength(1);
  });
});
