import { describe, expect, it } from 'vitest';
import { ParamEditor } from '../src/param-edit.ts';
import { extractVariablesInAssembly, extractVariablesInScope } from '../src/code-editor/index.ts';
import { applyFeatureEdit, type ApplyFeatureEditSpec } from '../src/apply-feature-edit/index.ts';

const code = `import { assembly, param, insert } from 'fluidcad/core';
import { beam } from './beam.part.js';
export const frame = assembly('Frame', () => {
  const width = param('Width', 700);
  const front = insert(beam, { Length: width });
  const later = 12;
  return { front };
});
`;

describe('assembly parameters', () => {
  it('adds a declaration after existing parameters and before their consumers', async () => {
    const added = await ParamEditor.apply(code, {
      kind: 'add', assembly: true, param: { label: 'Depth', defaultValue: 50, type: 'number' },
    });
    expect(added.error).toBeUndefined();
    expect(added.newCode).toContain("const width = param('Width', 700);\n  const depth = param('Depth', 50);\n  const front");
    const updated = await ParamEditor.apply(added.newCode, {
      kind: 'update', expectedLabel: 'Depth', param: { label: 'Depth', defaultValue: 90, type: 'number' },
    });
    expect(updated.newCode).toContain("const depth = param('Depth', 90)");
    const removed = await ParamEditor.apply(updated.newCode, { kind: 'remove', expectedLabel: 'Depth' });
    expect(removed.error).toBeUndefined();
    expect(removed.newCode).not.toContain('const depth');
  });

  it('opens an empty assembly body and ensures the param import', async () => {
    const result = await ParamEditor.apply("import { assembly } from 'fluidcad/core';\nexport const frame = assembly('Frame', () => {});", {
      kind: 'add', assembly: true, param: { label: 'Width', defaultValue: 50, type: 'number' },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain("() => {\n  const width = param('Width', 50);\n}");
    expect(result.newCode).toMatch(/import \{.*param.*\} from 'fluidcad\/core'/);
  });

  it.each([
    "const width = 1;",
    "const p = part('P', () => {});",
    "const a = assembly('A', () => {});\nconst b = assembly('B', () => {});",
  ])('refuses ambiguous or missing assembly bodies without modifying source', async source => {
    const result = await ParamEditor.apply(source, {
      kind: 'add', assembly: true, param: { label: 'Width', defaultValue: 50, type: 'number' },
    });
    expect(result.error).toContain('single assembly() callback');
    expect(result.newCode).toBe(source);
  });

  it('offers assembly parameters at the insertion point, excluding later and nested locals', async () => {
    const source = code.replace('  const front', "  function hidden() { const privateWidth = 10; }\n  const front");
    const variables = await extractVariablesInAssembly(source);
    expect(variables).toContainEqual({ name: 'width', initializer: "param('Width', 700)", numeric: true });
    expect(variables.map(v => v.name)).not.toContain('privateWidth');
    expect(variables.map(v => v.name)).not.toContain('later');
    const editScope = await extractVariablesInScope(code, 5);
    expect(editScope.map(v => v.name)).toContain('width');
  });

  it('writes batch expressions and declarations inside the assembly despite added imports', async () => {
    const spec: ApplyFeatureEditSpec = {
      feature: 'sketch', filePath: '/ws/frame.assembly.js', producers: [], parts: [], imports: [],
      insertPart: { inserts: [
        { importFrom: './beam.part.js', exportName: 'beam', kind: 'value', params: { Length: { expr: 'width / 2' } } },
        { importFrom: './plate.part.js', exportName: 'plate', kind: 'value', params: { Length: { expr: 'depth' } } },
      ] },
      newVariables: [{ name: 'depth', initializer: "param('Depth', 50)" }],
    };
    const result = await applyFeatureEdit(code, spec);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain("const width = param('Width', 700);\n  const depth = param('Depth', 50);");
    expect(result.newCode).toContain('insert(beam, { Length: width / 2 })');
    expect(result.newCode).toContain('insert(plate, { Length: depth })');
    expect(result.newCode.indexOf('const depth')).toBeGreaterThan(result.newCode.indexOf("assembly('Frame'"));
  });

  it('lands Edit Parameters declarations in the enclosing assembly', async () => {
    const result = await applyFeatureEdit(code, {
      feature: 'sketch', filePath: '/ws/frame.assembly.js', producers: [], parts: [], imports: [],
      insertParams: { line: 5, set: { Length: { expr: 'depth' } } },
      newVariables: [{ name: 'depth', initializer: "param('Depth', 50)" }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain("const width = param('Width', 700);\n  const depth = param('Depth', 50);\n  const front = insert(beam, { Length: depth });");
  });

  it('keeps inserts and their new declarations inside compact assembly bodies', async () => {
    const source = "import { assembly, param } from 'fluidcad/core';\nexport const frame = assembly('Frame', () => { const width = param('Width', 100); });";
    const result = await applyFeatureEdit(source, {
      feature: 'sketch', filePath: '/ws/frame.assembly.js', producers: [], parts: [], imports: [],
      insertPart: { inserts: [{ importFrom: './beam.part.js', exportName: 'beam', kind: 'value', params: { Length: { expr: 'length' } } }] },
      newVariables: [{ name: 'length', initializer: 'width / 2' }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('  const length = width / 2;\n  const beam1 = insert(beam, { Length: length }).name(\'beam1\');');
    expect(result.newCode.indexOf('const beam1')).toBeLessThan(result.newCode.lastIndexOf('});'));
  });
});
