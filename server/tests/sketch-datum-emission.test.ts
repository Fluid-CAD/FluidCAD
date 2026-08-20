import { describe, it, expect } from 'vitest';
import { applySolvedEmission } from '../src/sketch-solved-edit.ts';
import { applySketchConstraint } from '../src/sketch-constraint-edit.ts';

// Datum targets (origin/axes): rendered as their accessor calls
// (origin()/xAxis()/yAxis()) with the fluidcad/core import injected —
// datums have no source statement to hoist.

const SKETCH = [
  `import { sketch, line } from "fluidcad/core";`,
  ``,
  `sketch('xy', () => {`,
  `  const a = line([0, 0], [100, 0]);`,
  `  line([100, 0], [100, 50]);`,
  `}, true);`,
].join('\n');

describe('datum constraint targets', () => {
  it('renders origin() for a datum target and imports it from fluidcad/core', async () => {
    const result = await applySketchConstraint(SKETCH, {
      sketchLine: 3,
      kind: 'coincident',
      targets: [
        { line: 4, role: 'start', featureType: 'line' },
        { datum: 'origin' },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('coincident(a.start(), origin());');
    expect(result.newCode).toMatch(/import \{[^}]*\borigin\b[^}]*\} from "fluidcad\/core"/);
  });

  it('renders xAxis()/yAxis() and hoists only the statement target', async () => {
    const result = await applySolvedEmission(SKETCH, {
      sketchLine: 3,
      geometry: [],
      constraints: [
        { kind: 'collinear', targets: [{ datum: 'x-axis' }, { line: 5, featureType: 'line' }] },
        { kind: 'symmetric', targets: [
          { line: 4, role: 'start', featureType: 'line' },
          { line: 4, role: 'end', featureType: 'line' },
          { datum: 'y-axis' },
        ] },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('const l1 = line([100, 0], [100, 50]);');
    expect(result.newCode).toContain('collinear(xAxis(), l1);');
    expect(result.newCode).toContain('symmetric(a.start(), a.end(), yAxis());');
    expect(result.newCode).toMatch(/import \{[^}]*\bxAxis\b[^}]*\} from "fluidcad\/core"/);
    expect(result.newCode).toMatch(/import \{[^}]*\byAxis\b[^}]*\} from "fluidcad\/core"/);
  });

  it('accepts a datum target mixed with a same-emission geometry target', async () => {
    const result = await applySolvedEmission(SKETCH, {
      sketchLine: 3,
      geometry: [{ kind: 'point', text: 'point([0, 0])' }],
      constraints: [
        { kind: 'coincident', targets: [{ newIndex: 0 }, { datum: 'origin' }] },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('const p1 = point([0, 0]);');
    expect(result.newCode).toContain('coincident(p1, origin());');
  });

  it('refuses a datum target that also names a line, and unknown datums', async () => {
    const both = await applySolvedEmission(SKETCH, {
      sketchLine: 3,
      geometry: [],
      constraints: [
        { kind: 'coincident', targets: [{ line: 4, role: 'start' }, { datum: 'origin', line: 5 } as any] },
      ],
    });
    expect(both.error).toContain('exactly one of line/newIndex/datum');

    const unknown = await applySolvedEmission(SKETCH, {
      sketchLine: 3,
      geometry: [],
      constraints: [
        { kind: 'coincident', targets: [{ line: 4, role: 'start' }, { datum: 'z-axis' } as any] },
      ],
    });
    expect(unknown.error).toContain("unknown datum 'z-axis'");

    const withRole = await applySolvedEmission(SKETCH, {
      sketchLine: 3,
      geometry: [],
      constraints: [
        { kind: 'coincident', targets: [{ line: 4, role: 'start' }, { datum: 'x-axis', role: 'start' } as any] },
      ],
    });
    expect(withRole.error).toContain('datum target takes no point role');
  });
});
