import { describe, it, expect } from 'vitest';
import {
  applyFeatureEdit,
  parseFeatureStatement,
  type ApplyFeatureEditSpec,
  type HolePlacementSpec,
} from '../src/apply-feature-edit/index.ts';
import { HolePlacements } from '../src/apply-feature-edit/hole-placements.ts';

// hole() statements: each placement kind's staging and rendering, the parse
// round-trip, and in-place edits. Placements are the statement's trailing
// arguments; the chains refine the cut and end with `.scope(…)`.

const FILE = '/ws/plate.part.js';

/** A plate inside a part with a connector on its top face (line 7) and a sketch of points (line 8). */
const plate = [
  `import { part, sketch, circle, point, extrude, connector } from 'fluidcad/core'`,
  ``,
  `export const plate = part('Plate', () => {`,
  `  sketch('xy', () => { circle([0, 0], 100) })`,
  `  const e = extrude(10)`,
  `  const top = e.endFaces()`,
  `  connector('bolt', e.endFaces().center())`,
  `  sketch(e.endFaces(), () => {`,
  `    const c = circle([20, 0], 3)`,
  `    point([-20, 0])`,
  `  })`,
  `})`,
  ``,
].join('\n');

function holeSpec(
  hole: Partial<NonNullable<ApplyFeatureEditSpec['hole']>>,
  overrides: Partial<ApplyFeatureEditSpec> = {},
): ApplyFeatureEditSpec {
  return {
    feature: 'hole',
    filePath: FILE,
    hole: {
      size: { kind: 'fastener', label: 'M6' }, fastener: { type: 'clearance', fit: 'close' }, style: null,
      depth: null, tipAngle: null, placements: [], scope: [], ...hole,
    },
    producers: [],
    parts: [],
    imports: [],
    ...overrides,
  };
}

const BOLT = { line: 7, column: 2, featureType: 'connector', nameHint: 'c', bind: true };
const SKETCH = { line: 8, column: 2, featureType: 'sketch', nameHint: 's', bind: true };
const PLATE = { line: 5, column: 12, featureType: 'feature', nameHint: 'f', bind: true };

describe('hole statement templates', () => {
  it('names a connector placement by its statement and chains the options in order', async () => {
    const result = await applyFeatureEdit(plate, holeSpec({
      placements: [{ kind: 'connector', producer: 0 }],
      style: { kind: 'counterbore', diameter: null, depth: null },
      depth: 12, tipAngle: 118, scope: [1],
    }, { producers: [BOLT, PLATE] }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  const bolt = connector('bolt', e.endFaces().center())`);
    expect(result.newCode).toContain(`  hole('M6', bolt).clearance('close').counterbore().depth(12, 118).scope(e)\n})`);
    expect(result.newCode).toContain(`import { hole, part, sketch`);
  });

  it('renders a drilled hole with explicit counterbore values and a tapped hole with a pitch', async () => {
    const drilled = await applyFeatureEdit(plate, holeSpec({
      size: { kind: 'diameter', value: 5 }, fastener: null,
      style: { kind: 'counterbore', diameter: 9, depth: 4 }, placements: [{ kind: 'connector', producer: 0 }],
    }, { producers: [BOLT] }));
    expect(drilled.newCode).toContain(`hole(5, bolt).counterbore(9, 4)\n`);
    const tapped = await applyFeatureEdit(plate, holeSpec({
      fastener: { type: 'tapped', pitch: 0.75 }, style: { kind: 'countersink', diameter: null, angle: null },
      depth: 8, placements: [{ kind: 'connector', producer: 0 }],
    }, { producers: [BOLT] }));
    expect(tapped.newCode).toContain(`hole('M6', bolt).tapped(0.75).countersink().depth(8)\n`);
    const coarse = await applyFeatureEdit(plate, holeSpec({
      fastener: { type: 'tapped', pitch: null }, placements: [{ kind: 'connector', producer: 0 }],
    }, { producers: [BOLT] }));
    expect(coarse.newCode).toContain(`hole('M6', bolt).tapped()\n`);
  });

  it('exports a sketch point through the sketch return and names it from outside', async () => {
    const result = await applyFeatureEdit(plate, holeSpec({
      placements: [
        { kind: 'sketch', producer: 0, target: { line: 9, featureType: 'circle', role: 'center' } },
        { kind: 'sketch', producer: 0, target: { line: 10, featureType: 'point' } },
      ],
    }, { producers: [SKETCH] }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  const s = sketch(e.endFaces(), () => {`);
    // `p` is taken by `plate`, so the hoist steps to the next free name.
    expect(result.newCode).toContain(`    const p1 = point([-20, 0])`);
    expect(result.newCode).toContain(`    return { c, p1 };`);
    expect(result.newCode).toContain(`  hole('M6', s.geometries.c.center(), s.geometries.p1).clearance('close')\n})`);
  });

  it('creates a named connector inside the part for an anchor and drills at it', async () => {
    const create: ApplyFeatureEditSpec = {
      feature: 'connector',
      connector: { name: 'h1', part: { line: 3, column: 20 }, anchor: { kind: 'center' } },
      filePath: FILE,
      producers: [{ line: 5, column: 12, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'endFaces', indices: [0], filterArgs: null }],
      imports: [],
    };
    const result = await applyFeatureEdit(plate, holeSpec({
      placements: [{ kind: 'newConnector', name: 'h1', create }, { kind: 'connector', producer: 0 }],
    }, { producers: [BOLT] }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  const h1 = connector('h1', e.endFaces(0).center())`);
    expect(result.newCode).toContain(`  hole('M6', h1, bolt).clearance('close')\n})`);
    // The new statement lands before the hole, inside the part body.
    expect(result.newCode.indexOf(`const h1 =`)).toBeLessThan(result.newCode.indexOf(`hole('M6'`));
  });

  it('creates every new connector when the first adds an import line above the rest', async () => {
    // Filtered edge selectors need `edge` from fluidcad/filters, which the
    // file lacks: the first create adds that import line, shifting every
    // line the second create addresses (the extrude on line 5 moves to 6).
    const create = (name: string, filter: string): ApplyFeatureEditSpec => ({
      feature: 'connector',
      connector: { name, part: { line: 3, column: 20 }, anchor: { kind: 'center' } },
      filePath: FILE,
      producers: [{ line: 5, column: 12, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'endEdges', indices: null, filterArgs: filter }],
      imports: ['edge'],
    });
    const result = await applyFeatureEdit(plate, holeSpec({
      placements: [
        { kind: 'newConnector', name: 'h1', create: create('h1', `edge().above('xz')`) },
        { kind: 'newConnector', name: 'h2', create: create('h2', `edge().below('xz')`) },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`import { edge } from 'fluidcad/filters'`);
    expect(result.newCode).toContain(`  const h1 = connector('h1', e.endEdges(edge().above('xz')).center())`);
    expect(result.newCode).toContain(`  const h2 = connector('h2', e.endEdges(edge().below('xz')).center())`);
    expect(result.newCode).toContain(`  hole('M6', h1, h2).clearance('close')\n})`);
  });

  it('exports a sketch point after a new connector adds an import line above it', async () => {
    // The connector's filtered selector adds the `edge` import, shifting the
    // sketch (line 8 → 9) and its point (line 10 → 11) the export addresses.
    const create: ApplyFeatureEditSpec = {
      feature: 'connector',
      connector: { name: 'h1', part: { line: 3, column: 20 }, anchor: { kind: 'center' } },
      filePath: FILE,
      producers: [{ line: 5, column: 12, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'endEdges', indices: null, filterArgs: `edge().above('xz')` }],
      imports: ['edge'],
    };
    const result = await applyFeatureEdit(plate, holeSpec({
      placements: [
        { kind: 'newConnector', name: 'h1', create },
        { kind: 'sketch', producer: 0, target: { line: 10, featureType: 'point' } },
      ],
    }, { producers: [SKETCH] }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`import { edge } from 'fluidcad/filters'`);
    expect(result.newCode).toContain(`    const p1 = point([-20, 0])`);
    expect(result.newCode).toContain(`  hole('M6', h1, s.geometries.p1).clearance('close')\n})`);
  });

  it('refuses a new connector whose name the part already declares', async () => {
    const create: ApplyFeatureEditSpec = {
      feature: 'connector',
      connector: { name: 'bolt', part: { line: 3, column: 20 }, anchor: { kind: 'center' } },
      filePath: FILE,
      producers: [{ line: 5, column: 12, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'endFaces', indices: [0], filterArgs: null }],
      imports: [],
    };
    const result = await applyFeatureEdit(plate, holeSpec({
      placements: [{ kind: 'newConnector', name: 'bolt', create }],
    }));
    expect(result.error).toContain('already has a connector named "bolt"');
    expect(result.newCode).toBe(plate);
  });

  it('renders an anchored selector part outside a part', async () => {
    const code = [
      `import { sketch, circle, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { circle([0, 0], 100) })`,
      `extrude(10)`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, holeSpec({
      size: { kind: 'diameter', value: 6.4 }, fastener: null,
      placements: [{ kind: 'part', part: 0, suffix: '.center()' }],
    }, {
      producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'endFaces', indices: [0], filterArgs: null }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const e = extrude(10)\nhole(6.4, e.endFaces(0).center())\n`);
  });

  it('refuses an empty placement list and an unstaged placement', async () => {
    const empty = await applyFeatureEdit(plate, holeSpec({ placements: [] }));
    expect(empty.error).toBe('malformed hole edit spec');
    const unstaged = holeSpec({ placements: [{ kind: 'sketch', producer: 0, target: { line: 99, featureType: 'circle', role: 'center' } }] },
      { producers: [SKETCH] });
    const result = await applyFeatureEdit(plate, unstaged);
    expect(result.error).toContain('no statement at line 99');
    expect(result.newCode).toBe(plate);
  });
});

describe('hole statement parsing', () => {
  const withHole = (statement: string) => plate.replace(`  })\n})`, `  })\n  ${statement}\n})`);

  it('reads every chain back, resolving connector identifiers to their statements', async () => {
    const code = withHole(`hole('M6', bolt, s.geometries.c.center()).clearance('close').counterbore(11, 6.8).depth(12, 118).scope(e)`)
      .replace(`  connector('bolt'`, `  const bolt = connector('bolt'`);
    const parsed = await parseFeatureStatement(code, 12);
    expect(parsed).toEqual({
      ok: true,
      parsed: {
        feature: 'hole',
        size: { kind: 'fastener', label: 'M6' },
        fastener: { type: 'clearance', fit: 'close' },
        style: { kind: 'counterbore', diameter: 11, depth: 6.8 },
        depth: 12, tipAngle: 118,
        placementTexts: ['bolt', 's.geometries.c.center()'],
        placementRefs: [{ line: 7, column: 15 }, null],
        scopeTexts: ['e'], scopeRefs: [{ line: 5, column: 12 }],
      },
      statement: `hole('M6', bolt, s.geometries.c.center()).clearance('close').counterbore(11, 6.8).depth(12, 118).scope(e)`,
    });
  });

  it('reads a drilled hole, a bare tapped chain and a table countersink', async () => {
    const drilled = await parseFeatureStatement(withHole(`hole(5, bolt).countersink(9, 90).depth(4)`), 12);
    expect(drilled.ok && drilled.parsed).toMatchObject({
      feature: 'hole', size: { kind: 'diameter', value: 5 }, fastener: null,
      style: { kind: 'countersink', diameter: 9, angle: 90 }, depth: 4, tipAngle: null,
    });
    const tapped = await parseFeatureStatement(withHole(`hole('1/4', bolt).tapped().countersink()`), 12);
    expect(tapped.ok && tapped.parsed).toMatchObject({
      fastener: { type: 'tapped', pitch: null }, style: { kind: 'countersink', diameter: null, angle: null },
    });
  });

  it('refuses shapes the dialog cannot show', async () => {
    const both = await parseFeatureStatement(withHole(`hole('M6', bolt).clearance('close').tapped()`), 12);
    expect(both).toMatchObject({ ok: false, reason: expect.stringContaining('both .clearance() and .tapped()') });
    const drilledTable = await parseFeatureStatement(withHole(`hole(5, bolt).counterbore()`), 12);
    expect(drilledTable).toMatchObject({ ok: false, reason: expect.stringContaining('needs a fastener size') });
    const noPlacement = await parseFeatureStatement(withHole(`hole('M6')`), 12);
    expect(noPlacement).toMatchObject({ ok: false, reason: expect.stringContaining('has no placement') });
    const badFit = await parseFeatureStatement(withHole(`hole('M6', bolt).clearance('tight')`), 12);
    expect(badFit).toMatchObject({ ok: false, reason: expect.stringContaining("'close', 'normal' or 'loose'") });
  });
});

describe('hole in-place edits', () => {
  const edited = plate
    .replace(`  connector('bolt'`, `  const bolt = connector('bolt'`)
    .replace(`  })\n})`, `  })\n  hole('M6', bolt).clearance('close').depth(12)\n})`);

  function editSpec(hole: NonNullable<FeatureEdit['hole']>, overrides: Partial<ApplyFeatureEditSpec> = {}): ApplyFeatureEditSpec {
    return {
      feature: 'hole', filePath: FILE, producers: [], parts: [], imports: [],
      edit: { line: 12, column: 2, hole },
      ...overrides,
    };
  }
  type FeatureEdit = NonNullable<ApplyFeatureEditSpec['edit']>;

  const M6_CLOSE = { size: { kind: 'fastener' as const, label: 'M6' }, fastener: { type: 'clearance' as const, fit: 'close' as const } };

  it('rewrites the options and keeps the placements verbatim', async () => {
    const result = await applyFeatureEdit(edited, editSpec({
      ...M6_CLOSE, style: { kind: 'countersink', diameter: null, angle: null }, depth: null, tipAngle: null,
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  hole('M6', bolt).clearance('close').countersink()\n})`);
  });

  it('replaces the placement list: keeps by position, adds a staged sketch point, drops the rest', async () => {
    const placements: HolePlacementSpec[] = [
      { kind: 'sketch', producer: 0, target: { line: 9, featureType: 'circle', role: 'center' } },
      { kind: 'verbatim', sourceIndex: 0 },
    ];
    const result = await applyFeatureEdit(edited, editSpec({
      ...M6_CLOSE, style: null, depth: 12, tipAngle: null, placements,
    }, { producers: [SKETCH] }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`    return { c };`);
    expect(result.newCode).toContain(`  hole('M6', s.geometries.c.center(), bolt).clearance('close').depth(12)\n})`);
  });

  it('refuses dropping every placement and a stale keep index', async () => {
    const none = await applyFeatureEdit(edited, editSpec({ ...M6_CLOSE, style: null, depth: null, tipAngle: null, placements: [] }));
    expect(none.error).toContain('at least one placement');
    const stale = await applyFeatureEdit(edited, editSpec({
      ...M6_CLOSE, style: null, depth: null, tipAngle: null, placements: [{ kind: 'verbatim', sourceIndex: 4 }],
    }));
    expect(stale.error).toContain('no longer matches the statement');
  });

  it('re-picks the scope and drops it with an empty list', async () => {
    const scoped = await applyFeatureEdit(edited, editSpec({
      ...M6_CLOSE, style: null, depth: 12, tipAngle: null, scope: [{ kind: 'feature', producer: 0 }],
    }, { producers: [PLATE] }));
    expect(scoped.newCode).toContain(`  hole('M6', bolt).clearance('close').depth(12).scope(e)\n})`);
    const withScope = edited.replace(`.depth(12)`, `.depth(12).scope(e)`);
    const dropped = await applyFeatureEdit(withScope, editSpec({ ...M6_CLOSE, style: null, depth: 12, tipAngle: null, scope: [] }));
    expect(dropped.newCode).toContain(`  hole('M6', bolt).clearance('close').depth(12)\n})`);
  });
});

describe('HolePlacements.needsStaging', () => {
  it('is true only for sketch and new-connector placements', () => {
    expect(HolePlacements.needsStaging(holeSpec({ placements: [{ kind: 'connector', producer: 0 }] }))).toBe(false);
    expect(HolePlacements.needsStaging(holeSpec({ placements: [{ kind: 'sketch', producer: 0, target: { line: 9 } }] }))).toBe(true);
  });
});
