import { describe, expect, it } from 'vitest';
import { applyAssemblyConnectorEdit, getAssemblyConnectorExpressions, listAssemblyConnectorNames } from '../src/assembly-connector-edit.ts';
import { applyFeatureEdit } from '../src/apply-feature-edit.ts';

const HEADER = `import { insert, mate } from "fluidcad/core";\n`;

// The assembly-connector dialog's statement writer: `create` lands a
// canonical `const <name> = connector('<name>', [x, y, z])<rotates>;` at the
// top level, `edit` rewrites the tuple, name and rotate chain in place with
// per-axis expression echo, refusing chains it does not model.
describe('applyAssemblyConnectorEdit', () => {
  describe('create', () => {
    it('appends a bound statement with the import, zero angles omitted', async () => {
      const code = `${HEADER}\nconst arm1 = insert(arm());\n`;
      const result = await applyAssemblyConnectorEdit(code, {
        create: { name: 'hinge' },
        position: [40, 0, 12],
        rotateXYZ: [90, 0, 0],
      });
      expect(result.error).toBeUndefined();
      expect(result.newCode).toMatch(/import \{[^}]*\bconnector\b[^}]*\} from "fluidcad\/core";/);
      expect(result.newCode).toContain(`\nconst hinge = connector('hinge', [40, 0, 12]).rotate('x', 90);\n`);
      const lines = result.newCode.split('\n');
      expect(lines[result.statementLine! - 1]).toBe(`const hinge = connector('hinge', [40, 0, 12]).rotate('x', 90);`);
    });

    it('lands before the first top-level mate() so joints read after their frames', async () => {
      const code = `${HEADER}\nconst arm1 = insert(arm());\nconst base1 = insert(base());\n\n`
        + `mate('revolute', arm1.connectors.hinge, base1.connectors.hinge);\n`;
      const result = await applyAssemblyConnectorEdit(code, {
        create: { name: 'frame' },
        position: [0, 0, 0],
        rotateXYZ: null,
      });
      expect(result.error).toBeUndefined();
      expect(result.newCode).toContain(
        `const base1 = insert(base());\n\nconst frame = connector('frame', [0, 0, 0]);\n\nmate('revolute'`,
      );
      expect(result.newCode.split('\n')[result.statementLine! - 1]).toBe(`const frame = connector('frame', [0, 0, 0]);`);
    });

    it('suffixes the binding when the name is taken and refuses a declared connector name', async () => {
      const code = `${HEADER}\nconst base = insert(base());\n`;
      const result = await applyAssemblyConnectorEdit(code, {
        create: { name: 'base' },
        position: [1, 2, 3],
        rotateXYZ: [0, 0, 45],
      });
      expect(result.newCode).toContain(`const base1 = connector('base', [1, 2, 3]).rotate('z', 45);`);
      const dup = await applyAssemblyConnectorEdit(result.newCode, {
        create: { name: 'base' },
        position: [0, 0, 0],
        rotateXYZ: null,
      });
      expect(dup.error).toMatch(/already declares a connector named "base"/);
    });

    it('writes expression texts verbatim, even at identity', async () => {
      const result = await applyAssemblyConnectorEdit(`${HEADER}\n`, {
        create: { name: 'c1' },
        position: [0, 0, 0],
        rotateXYZ: [0, 0, 0],
        positionExprs: ['w / 2', null, 'h'],
        rotateExprs: [null, 'tilt', null],
      });
      expect(result.newCode).toContain(`const c1 = connector('c1', [w / 2, 0, h]).rotate('y', tilt);`);
    });

    it('rejects bad names and non-finite numbers', async () => {
      const bad = await applyAssemblyConnectorEdit(`${HEADER}\n`, {
        create: { name: 'not valid' },
        position: [0, 0, 0],
        rotateXYZ: null,
      });
      expect(bad.error).toMatch(/not a valid connector name/);
      const nan = await applyAssemblyConnectorEdit(`${HEADER}\n`, {
        create: { name: 'ok' },
        position: [0, Number.NaN, 0],
        rotateXYZ: null,
      });
      expect(nan.error).toMatch(/finite/);
    });
  });

  describe('edit', () => {
    const CODE = `${HEADER}\nconst c1 = insert(c());\nconst pivot = connector('pivot', [0, 0, 10]).rotate('x', 90);\n\n`
      + `mate('revolute', pivot, c1.connectors.shaft);\n`;

    it('rewrites the tuple, name literal and canonical rotate chain in place', async () => {
      const result = await applyAssemblyConnectorEdit(CODE, {
        edit: { sourceLine: 4, name: 'hinge' },
        position: [5, 6, 7],
        rotateXYZ: [0, 30, 0],
      });
      expect(result.error).toBeUndefined();
      expect(result.newCode).toContain(`const pivot = connector('hinge', [5, 6, 7]).rotate('y', 30);`);
      expect(result.newCode).toContain(`mate('revolute', pivot, c1.connectors.shaft);`);
      expect(result.statementLine).toBe(4);
    });

    it('position-only commit leaves the rotate chain untouched', async () => {
      const code = `${HEADER}\nconst p = connector('p', [0, 0, 0]).offset(0, 0, 5).rotate('x', 90);\n`;
      const result = await applyAssemblyConnectorEdit(code, {
        edit: { sourceLine: 3, name: 'p' },
        position: [1, 2, 3],
        rotateXYZ: null,
      });
      expect(result.newCode).toContain(`const p = connector('p', [1, 2, 3]).offset(0, 0, 5).rotate('x', 90);`);
    });

    it('echoes per-axis expression texts through a rewrite', async () => {
      const code = `${HEADER}\nconst p = connector('p', [w, 0, h]).rotate('x', a).rotate('z', 10);\n`;
      const result = await applyAssemblyConnectorEdit(code, {
        edit: { sourceLine: 3, name: 'p' },
        position: [0, 4, 0],
        rotateXYZ: [90, 0, 20],
        positionExprs: ['w', null, 'h'],
        rotateExprs: ['a', null, null],
      });
      expect(result.error).toBeUndefined();
      expect(result.newCode).toContain(`const p = connector('p', [w, 4, h]).rotate('x', a).rotate('z', 20);`);
    });

    it('refuses a rotation rewrite over an .offset() chain, an opaque axis, or an uncovered expression angle', async () => {
      const offset = await applyAssemblyConnectorEdit(`${HEADER}\nconst p = connector('p', [0, 0, 0]).offset(0, 0, 5).rotate('x', 90);\n`, {
        edit: { sourceLine: 3, name: 'p' },
        position: [0, 0, 0],
        rotateXYZ: [0, 0, 0],
      });
      expect(offset.error).toMatch(/chains \.offset\(\)/);
      const opaque = await applyAssemblyConnectorEdit(`${HEADER}\nconst p = connector('p', [0, 0, 0]).rotate(axis, 90);\n`, {
        edit: { sourceLine: 3, name: 'p' },
        position: [0, 0, 0],
        rotateXYZ: [0, 0, 0],
      });
      expect(opaque.error).toMatch(/isn't a plain/);
      const uncovered = await applyAssemblyConnectorEdit(`${HEADER}\nconst p = connector('p', [0, 0, 0]).rotate('x', a);\n`, {
        edit: { sourceLine: 3, name: 'p' },
        position: [0, 0, 0],
        rotateXYZ: [90, 0, 0],
      });
      expect(uncovered.error).toMatch(/expression angle/);
    });

    it('refuses when the line is not an assembly connector', async () => {
      const notConnector = await applyAssemblyConnectorEdit(CODE, {
        edit: { sourceLine: 3, name: 'x' },
        position: [0, 0, 0],
        rotateXYZ: null,
      });
      expect(notConnector.error).toMatch(/isn't a connector\(\)/);
      const partConnector = await applyAssemblyConnectorEdit(`${HEADER}\nconnector('top', select(face()));\n`, {
        edit: { sourceLine: 3, name: 'top' },
        position: [0, 0, 0],
        rotateXYZ: null,
      });
      expect(partConnector.error).toMatch(/not an assembly connector/);
      const renameClash = await applyAssemblyConnectorEdit(`${CODE}const other = connector('other', [1, 1, 1]);\n`, {
        edit: { sourceLine: 4, name: 'other' },
        position: [0, 0, 0],
        rotateXYZ: null,
      });
      expect(renameClash.error).toMatch(/already declares/);
    });
  });

  it('rides the apply-feature side-channel and lands new variable declarations', async () => {
    const code = `${HEADER}\nconst c1 = insert(c());\n`;
    const result = await applyFeatureEdit(code, {
      feature: 'sketch',
      filePath: '/ws/m.assembly.js',
      producers: [],
      parts: [],
      imports: [],
      assemblyConnector: {
        create: { name: 'base' },
        position: [0, 0, 0],
        rotateXYZ: null,
        positionExprs: ['lift', null, null],
      },
      newVariables: [{ name: 'lift', initializer: '12' }],
    } as any);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const lift = 12;\nconst base = connector('base', [lift, 0, 0]);`);
  });
});

describe('getAssemblyConnectorExpressions', () => {
  it('reads tuple and canonical rotate texts, null for non-canonical shapes', async () => {
    const canonical = await getAssemblyConnectorExpressions(`${HEADER}\nconst p = connector('p', [w, 0, h]).rotate('x', a).rotate('z', 10);\n`, 3);
    expect(canonical).toEqual({ position: { x: 'w', y: '0', z: 'h' }, rotate: { x: 'a', y: null, z: '10' } });
    const offset = await getAssemblyConnectorExpressions(`${HEADER}\nconst p = connector('p', [0, 0, 0]).offset(0, 0, 5).rotate('x', 90);\n`, 3);
    expect(offset).toEqual({ position: { x: '0', y: '0', z: '0' }, rotate: null });
    const reordered = await getAssemblyConnectorExpressions(`${HEADER}\nconst p = connector('p', [0, 0, 0]).rotate('z', 5).rotate('x', 90);\n`, 3);
    expect(reordered!.rotate).toBeNull();
    const partConnector = await getAssemblyConnectorExpressions(`${HEADER}\nconnector('top', select(face()));\n`, 3);
    expect(partConnector).toEqual({ position: null, rotate: { x: null, y: null, z: null } });
    expect(await getAssemblyConnectorExpressions(`${HEADER}\nconst c1 = insert(c());\n`, 3)).toBeNull();
  });

  it('lists declared connector names', async () => {
    const names = await listAssemblyConnectorNames(`${HEADER}\nconst a = connector('a', [0, 0, 0]);\nconnector('b', [1, 1, 1]);\nconst c1 = insert(c());\n`);
    expect(names).toEqual(['a', 'b']);
  });
});
