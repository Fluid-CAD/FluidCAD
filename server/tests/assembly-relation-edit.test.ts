import { describe, it, expect } from 'vitest';
import { applyAssemblyRelationEdit } from '../src/assembly-relation-edit.ts';
import { removeStatementWithAssemblySweep } from '../src/assembly-delete-sweep.ts';

const HEADER = `import { insert, mate } from "fluidcad/core";\n`;

// The relation dialog's statement writer: `create` appends a canonical
// `relation(type, mateA, mateB, ratio)<chain>` statement in the mates'
// scope, `edit` re-renders the statement at its source line.
describe('applyAssemblyRelationEdit', () => {
  // Lines: 1 import, 2 blank, 3 base1, 4 g1, 5 g2, 6 pinion mate, 7 bare mate.
  const code = [
    HEADER.trimEnd(),
    '',
    'const base1 = insert(base()).grounded();',
    'const g1 = insert(gear());',
    'const g2 = insert(gear());',
    "const pinion = mate('revolute', base1.connectors.a1, g1.connectors.bore);",
    "mate('revolute', base1.connectors.a2, g2.connectors.bore);",
    '',
  ].join('\n');

  describe('create', () => {
    it('appends the relation under the mates, binding a bare mate and importing relation', async () => {
      const result = await applyAssemblyRelationEdit(code, {
        create: { type: 'gear', mateA: { mateLine: 6 }, mateB: { mateLine: 7 }, ratio: 2 },
      });
      expect(result.error).toBeUndefined();
      expect(result.newCode).toBe([
        'import { relation, insert, mate } from "fluidcad/core";',
        '',
        'const base1 = insert(base()).grounded();',
        'const g1 = insert(gear());',
        'const g2 = insert(gear());',
        "const pinion = mate('revolute', base1.connectors.a1, g1.connectors.bore);",
        "const mate1 = mate('revolute', base1.connectors.a2, g2.connectors.bore);",
        "relation('gear', pinion, mate1, 2);",
        '',
      ].join('\n'));
    });

    it('renders .reverse() and short ratios exactly', async () => {
      const result = await applyAssemblyRelationEdit(code, {
        create: { type: 'gear', mateA: { mateLine: 6 }, mateB: { mateLine: 7 }, ratio: 62.8, reverse: true },
      });
      expect(result.newCode).toContain("relation('gear', pinion, mate1, 62.8).reverse();");
      const half = await applyAssemblyRelationEdit(code, {
        create: { type: 'gear', mateA: { mateLine: 7 }, mateB: { mateLine: 6 }, ratio: 0.5, reverse: false },
      });
      expect(half.newCode).toContain("relation('gear', mate1, pinion, 0.5);");
    });

    it('lands inside the assembly body the mates live in, before its return', async () => {
      const scoped = [
        'import { assembly, insert, mate } from "fluidcad/core";',
        '',
        "export const box = assembly('box', () => {",
        '  const base1 = insert(base()).grounded();',
        '  const g1 = insert(gear());',
        "  const a = mate('revolute', base1.connectors.a1, g1.connectors.bore);",
        "  const b = mate('cylindrical', base1.connectors.a2, g1.connectors.top);",
        '  return { g1 };',
        '});',
        '',
      ].join('\n');
      const result = await applyAssemblyRelationEdit(scoped, {
        create: { type: 'gear', mateA: { mateLine: 6 }, mateB: { mateLine: 7 }, ratio: 3 },
      });
      expect(result.error).toBeUndefined();
      expect(result.newCode).toContain("  const b = mate('cylindrical', base1.connectors.a2, g1.connectors.top);\n  relation('gear', a, b, 3);\n  return { g1 };");
    });

    it('refuses mates from different assembly bodies', async () => {
      const split = [
        'import { assembly, insert, mate } from "fluidcad/core";',
        "export const one = assembly('one', () => {",
        '  const g1 = insert(gear());',
        "  const a = mate('revolute', g1.connectors.a1, g1.connectors.bore);",
        '});',
        "export const two = assembly('two', () => {",
        '  const g2 = insert(gear());',
        "  const b = mate('revolute', g2.connectors.a1, g2.connectors.bore);",
        '});',
      ].join('\n');
      const result = await applyAssemblyRelationEdit(split, {
        create: { type: 'gear', mateA: { mateLine: 4 }, mateB: { mateLine: 8 }, ratio: 1 },
      });
      expect(result.error).toMatch(/different assembly bodies/);
      expect(result.newCode).toBe(split);
    });
  });

  describe('edit', () => {
    it('re-renders the statement in place from the full payload', async () => {
      const withRelation = code.replace(
        "mate('revolute', base1.connectors.a2, g2.connectors.bore);\n",
        "const wheel = mate('revolute', base1.connectors.a2, g2.connectors.bore);\nrelation('gear', pinion, wheel, 2).reverse();\n",
      );
      const result = await applyAssemblyRelationEdit(withRelation, {
        edit: { sourceLine: 8, type: 'gear', mateA: { mateLine: 7 }, mateB: { mateLine: 6 }, ratio: 1.5 },
      });
      expect(result.error).toBeUndefined();
      expect(result.newCode).toContain("relation('gear', wheel, pinion, 1.5);\n");
      expect(result.newCode).not.toContain('.reverse()');
    });

    it('refuses a source line that is not a relation()', async () => {
      const result = await applyAssemblyRelationEdit(code, {
        edit: { sourceLine: 6, type: 'gear', mateA: { mateLine: 6 }, mateB: { mateLine: 7 }, ratio: 1 },
      });
      expect(result.error).toMatch(/no relation\(\) statement found on line 6/);
    });
  });

  describe('validation', () => {
    const create = (payload: Record<string, unknown>) =>
      applyAssemblyRelationEdit(code, { create: { type: 'gear', mateA: { mateLine: 6 }, mateB: { mateLine: 7 }, ratio: 2, ...payload } as never });

    it('refuses unknown types, self-relations and bad ratios before touching the source', async () => {
      expect((await create({ type: 'belt' })).error).toMatch(/unknown relation type "belt"/);
      expect((await create({ mateB: { mateLine: 6 } })).error).toMatch(/related to itself/);
      expect((await create({ ratio: 0 })).error).toMatch(/must be positive/);
      expect((await create({ ratio: -2 })).error).toMatch(/Reverse/);
      expect((await create({ ratio: Number.NaN })).error).toMatch(/finite number/);
      expect((await create({ type: 'rack-and-pinion', ratio: -1 })).error).toMatch(/travel per revolution must be positive/);
    });

    it('refuses a side whose line is not a mate() statement', async () => {
      expect((await create({ mateA: { mateLine: 4 } })).error).toMatch(/not a mate\(\)/);
      expect((await create({ mateA: { mateLine: 2 } })).error).toMatch(/no mate\(\) statement found on line 2/);
    });

    it('refuses mate types with nothing to couple, naming the side', async () => {
      const typed = code
        .replace("mate('revolute', base1.connectors.a1", "mate('fastened', base1.connectors.a1")
        .replace("mate('revolute', base1.connectors.a2", "mate('slider', base1.connectors.a2");
      const gear = await applyAssemblyRelationEdit(typed, {
        create: { type: 'gear', mateA: { mateLine: 6 }, mateB: { mateLine: 7 }, ratio: 2 },
      });
      expect(gear.error).toMatch(/first mate is 'fastened'/);
      const rack = await applyAssemblyRelationEdit(typed, {
        create: { type: 'rack-and-pinion', mateA: { mateLine: 7 }, mateB: { mateLine: 6 }, ratio: 2 },
      });
      expect(rack.error).toMatch(/pinion side must be a revolute or cylindrical/);
      const planar = await applyAssemblyRelationEdit(typed.replace("mate('fastened'", "mate('planar'"), {
        create: { type: 'rack-and-pinion', mateA: { mateLine: 7 }, mateB: { mateLine: 6 }, ratio: 2 },
      });
      expect(planar.error).toMatch(/first mate is 'slider'/);
    });
  });
});

// Deleting a mate takes the relations that couple it along; deleting an
// insert takes its mates, and through them their relations.
describe('removeStatementWithAssemblySweep — relations', () => {
  const code = [
    'import { insert, mate, relation } from "fluidcad/core";',
    '',
    'const base1 = insert(base()).grounded();',
    'const g1 = insert(gear());',
    'const g2 = insert(gear());',
    'const rack1 = insert(rack());',
    "const pinion = mate('revolute', base1.connectors.a1, g1.connectors.bore);",
    "const wheel = mate('revolute', base1.connectors.a2, g2.connectors.bore);",
    "const travel = mate('slider', base1.connectors.rail, rack1.connectors.slot);",
    "relation('gear', pinion, wheel, 2);",
    "relation('rack-and-pinion', wheel, travel, 40).reverse();",
    '',
  ].join('\n');

  it('deleting a mate removes every relation that names its binding', async () => {
    const result = await removeStatementWithAssemblySweep(code, 8);
    expect(result.newCode).toBe([
      'import { insert, mate, relation } from "fluidcad/core";',
      '',
      'const base1 = insert(base()).grounded();',
      'const g1 = insert(gear());',
      'const g2 = insert(gear());',
      'const rack1 = insert(rack());',
      "const pinion = mate('revolute', base1.connectors.a1, g1.connectors.bore);",
      "const travel = mate('slider', base1.connectors.rail, rack1.connectors.slot);",
      '',
    ].join('\n'));
  });

  it('deleting an insert sweeps its mates and, through them, their relations', async () => {
    const result = await removeStatementWithAssemblySweep(code, 4);
    expect(result.newCode).not.toContain('const pinion');
    expect(result.newCode).not.toContain('const g1');
    expect(result.newCode).toContain("relation('rack-and-pinion', wheel, travel, 40).reverse();");
    expect(result.newCode).not.toContain("relation('gear'");
  });

  it('deleting a relation removes just that statement', async () => {
    const result = await removeStatementWithAssemblySweep(code, 10);
    expect(result.newCode).toBe(code.replace("relation('gear', pinion, wheel, 2);\n", ''));
  });
});
