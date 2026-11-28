import { describe, it, expect } from 'vitest';
import { updateSketchPositions } from '../src/code-editor/index.ts';
import { applySolvedEmission } from '../src/sketch-solved-edit/index.ts';
import { SketchEntityDelete } from '../src/sketch-entity-delete.ts';
import { lintFluidJs } from '../src/lint-fluid-js.ts';

// The elliptical arc statement, eArc(start, end, center, rx, ry[, rotation]),
// through the server's source transforms: it is an entity statement like
// arc() for its three points and like ellipse() for its radii and rotation.

describe('eArc: position write-back', () => {
  const code = [
    `import { sketch, eArc } from "fluidcad/core";`,
    ``,
    `sketch('xy', () => {`,
    `  const ea1 = eArc([40, 0], [0, 20], [0, 0], 40, 20);`,
    `  const ea2 = eArc([90, 0], [50, 20], [50, 0], w, 20, 15).cw().name('cam');`,
    `});`,
  ].join('\n');

  it('splices the three points, both semi-radii, and appends a rotation', async () => {
    const result = await updateSketchPositions(code, [{
      sourceLine: 4,
      points: [
        { pointIndex: 0, position: [41.504, 1], expected: [40, 0] },
        { pointIndex: 1, position: [1, 22], expected: [0, 20] },
        { pointIndex: 2, position: [1, 1], expected: [0, 0] },
      ],
      radii: { rx: { value: 42, expected: 40 }, ry: { value: 21, expected: 20 } },
      rotation: { value: 30 },
    }]);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const ea1 = eArc([41.5, 1], [1, 22], [1, 1], 42, 21, 30);`);
  });

  it('rewrites an existing rotation and leaves a non-literal radius alone, through a chain', async () => {
    const result = await updateSketchPositions(code, [{
      sourceLine: 5,
      points: [{ pointIndex: 2, position: [55, 5], expected: [50, 0] }],
      radii: { rx: { value: 9, expected: 1 }, ry: { value: 24, expected: 20 } },
      rotation: { value: 45, expected: 15 },
    }]);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const ea2 = eArc([90, 0], [50, 20], [55, 5], w, 24, 45).cw().name('cam');`);
  });

  it('refuses a drifted radius and a drifted rotation, changing nothing', async () => {
    const drifted = await updateSketchPositions(code, [
      { sourceLine: 4, radii: { ry: { value: 12, expected: 11 } } },
    ]);
    expect(drifted.error).toMatch(/expected ry 11, found 20/);
    expect(drifted.newCode).toBe(code);
    const turned = await updateSketchPositions(code, [
      { sourceLine: 5, rotation: { value: 50, expected: 10 } },
    ]);
    expect(turned.error).toMatch(/expected rotation 10, found 15/);
    expect(turned.newCode).toBe(code);
  });

  it('refuses radii aimed at a statement that is neither an ellipse nor an elliptical arc', async () => {
    const other = [
      `import { sketch, circle } from "fluidcad/core";`,
      ``,
      `sketch('xy', () => {`,
      `  const c = circle([0, 0], 20);`,
      `});`,
    ].join('\n');
    const result = await updateSketchPositions(other, [
      { sourceLine: 4, radii: { rx: { value: 12 } } },
    ]);
    expect(result.error).toMatch(/is not an ellipse\(\) or eArc\(\) statement/);
  });
});

describe('eArc: emission', () => {
  const sketchCode = [
    `import { sketch, line } from "fluidcad/core";`,
    `import { horizontal } from "fluidcad/constraints";`,
    ``,
    `sketch('xy', () => {`,
    `  const a = line([0, 0], [100, 0]);`,
    `  horizontal(a);`,
    `});`,
  ].join('\n');

  it('binds a new elliptical arc and renders its three point roles and its bare name', async () => {
    const result = await applySolvedEmission(sketchCode, {
      sketchLine: 4,
      geometry: [{ kind: 'eArc', text: 'eArc([40, 0], [0, 20], [0, 0], 40, 20)' }],
      constraints: [
        { kind: 'coincident', targets: [{ newIndex: 0, role: 'center' }, { datum: 'origin' }] },
        { kind: 'coincident', targets: [{ newIndex: 0, role: 'start' }, { line: 5, role: 'end', featureType: 'line' }] },
        { kind: 'coincident', targets: [{ newIndex: 0, role: 'end' }, { datum: 'y-axis' }] },
        { kind: 'tangent', targets: [{ line: 5, featureType: 'line' }, { newIndex: 0 }] },
        { kind: 'radius', targets: [{ newIndex: 0 }], valueExpr: '40', axis: 'x' },
      ],
    });
    expect(result.error).toBeUndefined();
    const name = result.names?.[0];
    expect(name).toMatch(/^ea\d+$/);
    expect(result.newCode).toContain(`const ${name} = eArc([40, 0], [0, 20], [0, 0], 40, 20);`);
    expect(result.newCode).toContain(`coincident(${name}.center(), origin());`);
    expect(result.newCode).toContain(`coincident(${name}.start(), a.end());`);
    expect(result.newCode).toContain(`coincident(${name}.end(), yAxis());`);
    expect(result.newCode).toContain(`tangent(a, ${name});`);
    expect(result.newCode).toContain(`radius(${name}, 40, 'x');`);
    expect(result.newCode.split('\n')[0]).toMatch(/import \{[^}]*\beArc\b[^}]*\} from "fluidcad\/core";/);
  });

  it('addresses an existing elliptical arc by line, hoisting an unbound one', async () => {
    const existing = [
      `import { sketch, eArc } from "fluidcad/core";`,
      ``,
      `sketch('xy', () => {`,
      `  eArc([40, 0], [0, 20], [0, 0], 40, 20).cw();`,
      `});`,
    ].join('\n');
    const result = await applySolvedEmission(existing, {
      sketchLine: 3,
      geometry: [],
      constraints: [
        { kind: 'horizontal', targets: [{ line: 4, featureType: 'eArc' }] },
        { kind: 'coincident', targets: [{ line: 4, featureType: 'eArc', role: 'start' }, { datum: 'x-axis' }] },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toMatch(/const (ea\d+) = eArc\(\[40, 0\], \[0, 20\], \[0, 0\], 40, 20\)\.cw\(\);/);
    expect(result.newCode).toMatch(/horizontal\(ea\d+\);/);
    expect(result.newCode).toMatch(/coincident\(ea\d+\.start\(\), xAxis\(\)\);/);
  });

  it('refuses a target whose line is not the statement it names', async () => {
    const result = await applySolvedEmission(sketchCode, {
      sketchLine: 4,
      geometry: [],
      constraints: [{ kind: 'horizontal', targets: [{ line: 5, featureType: 'eArc' }] }],
    });
    expect(result.error).toBeDefined();
    expect(result.newCode).toBe(sketchCode);
  });
});

describe('eArc: delete and lint', () => {
  it('a deleted elliptical arc leaves its points behind where other geometry borrowed them', async () => {
    const code = [
      `import { sketch, line, eArc } from "fluidcad/core";`,
      `import { coincident, horizontal } from "fluidcad/constraints";`,
      ``,
      `sketch('xy', () => {`,
      `  const ea1 = eArc([40, 0], [0, 20], [3, 4], 40, 20, 10);`,
      `  const l1 = line(ea1.start(), ea1.center());`,
      `  const l2 = line(ea1.end(), [50, 50]);`,
      `  horizontal(ea1);`,
      `});`,
    ].join('\n');
    const result = await SketchEntityDelete.apply(code, { sketchLine: 4, lines: [5] });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const l1 = line([40, 0], [3, 4]);`);
    expect(result.newCode).toContain(`const l2 = line([0, 20], [50, 50]);`);
    expect(result.newCode).not.toContain('eArc(');
    expect(result.newCode).not.toContain('horizontal(');
  });

  it('the import lint knows eArc as a core symbol', async () => {
    const code = [
      'import { sketch } from "fluidcad/core";',
      '',
      'sketch("xy", () => { eArc([40, 0], [0, 20], [0, 0], 40, 20); });',
      '',
    ].join('\n');
    const result = await lintFluidJs(code);
    expect(result.missing.map(m => [m.symbol, m.module])).toEqual([['eArc', 'fluidcad/core']]);
  });
});
