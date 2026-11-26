import { describe, it, expect } from 'vitest';
import {
  applyFeatureEdit,
  Directions,
  renderHelixSourceExpr,
  renderHelixStatement,
  type ApplyFeatureEditSpec,
  type DirectionSpec,
  type HelixSourceSpec,
} from '../src/apply-feature-edit/index.ts';

function src(...lines: string[]): string {
  return [...lines, ''].join('\n');
}

type Producer = ApplyFeatureEditSpec['producers'][number];
type Part = ApplyFeatureEditSpec['parts'][number];

const producer = (line: number, featureType: string, nameHint: string): Producer =>
  ({ line, column: 0, featureType, nameHint, bind: true });

/** `<producer>.<accessor>(<indices>)`. */
const bucket = (index: number, accessor: string, ...indices: number[]): Part =>
  ({ producer: index, accessor, indices, filterArgs: null });

/** An axis statement, a plane statement, a connector and a solid, in that order. */
const HOST = {
  producers: [
    producer(3, 'axis', 'a'), producer(4, 'plane', 'p'), producer(5, 'connector', 'c'), producer(6, 'extrude', 'e'),
  ],
  parts: [bucket(3, 'sideEdges', 0), bucket(3, 'endFaces', 0)],
};

const NAMES = ['spin', 'datum', 'bolt', 'e'];
const named = (index: number): string | null => NAMES[index] ?? null;
const unnamed = (): null => null;

describe('Directions.render', () => {
  const render = (direction: DirectionSpec): string => Directions.render(direction, HOST.parts, named);

  it('renders a world axis and an origin plane as their literals', () => {
    expect(render({ kind: 'standard', axis: 'z' })).toBe(`'z'`);
    expect(render({ kind: 'standard-plane', plane: 'xy' })).toBe(`'xy'`);
  });

  it('renders an axis statement and a plane statement as their variables', () => {
    expect(render({ kind: 'axis', producer: 0 })).toBe('spin');
    expect(render({ kind: 'plane', producer: 1 })).toBe('datum');
    expect(Directions.render({ kind: 'axis', producer: 0 }, HOST.parts, unnamed)).toBe('a');
    expect(Directions.render({ kind: 'plane', producer: 1 }, HOST.parts, unnamed)).toBe('p');
  });

  it('renders a connector, and one of its copies', () => {
    expect(render({ kind: 'connector', producer: 2 })).toBe('bolt');
    expect(render({ kind: 'connector', producer: 2, slot: 2 })).toBe('bolt.instance(2)');
  });

  it('renders a picked edge and a picked face as their bare selectors, by their part', () => {
    expect(render({ kind: 'edge' })).toBe('e.sideEdges(0)');
    expect(render({ kind: 'face', part: 1 })).toBe('e.endFaces(0)');
  });
});

describe('Directions.validate', () => {
  it('reads every kind of direction a spec can carry', () => {
    const directions: DirectionSpec[] = [
      { kind: 'standard', axis: 'x' },
      { kind: 'standard-plane', plane: 'yz' },
      { kind: 'axis', producer: 0 },
      { kind: 'plane', producer: 1 },
      { kind: 'connector', producer: 2 },
      { kind: 'connector', producer: 2, slot: 3 },
      { kind: 'edge' },
      { kind: 'face', part: 1 },
    ];
    for (const direction of directions) {
      expect(Directions.validate(direction, HOST), direction.kind).toEqual(direction);
    }
  });

  it('refuses a name that is no world axis or origin plane', () => {
    expect(Directions.validate({ kind: 'standard', axis: 'xy' }, HOST)).toEqual({ error: 'bad standard axis' });
    expect(Directions.validate({ kind: 'standard-plane', plane: 'z' }, HOST)).toEqual({ error: 'bad standard plane' });
  });

  it('refuses a producer of another kind, and names the slot', () => {
    expect(Directions.validate({ kind: 'axis', producer: 1 }, HOST))
      .toEqual({ error: 'the direction references a non-axis producer' });
    expect(Directions.validate({ kind: 'plane', producer: 0 }, HOST))
      .toEqual({ error: 'the direction references a non-plane producer' });
    expect(Directions.validate({ kind: 'connector', producer: 3 }, HOST, 'source'))
      .toEqual({ error: 'the source references a non-connector producer' });
    expect(Directions.validate({ kind: 'connector', producer: 2, slot: -1 }, HOST))
      .toEqual({ error: 'the direction references a non-connector producer' });
  });

  it('refuses a picked edge or face the spec holds no part for, and an unknown kind', () => {
    expect(Directions.validate({ kind: 'edge', part: 2 }, HOST)).toEqual({ error: 'the direction references no selector part' });
    expect(Directions.validate({ kind: 'face' }, { producers: [], parts: [] }))
      .toEqual({ error: 'the direction references no selector part' });
    expect(Directions.validate({ kind: 'vector', x: 1 }, HOST)).toEqual({ error: 'unknown direction kind' });
    expect(Directions.validate(null, HOST)).toEqual({ error: 'unknown direction kind' });
  });
});

describe("helix's statements through Directions", () => {
  const CHAINS = { radius: 15, endRadius: null, pitch: 10, turns: 4, height: null, startOffset: null, endOffset: null };

  it('writes each helix source as before: an edge as the axis it gives, the rest as a direction', () => {
    const source = (spec: HelixSourceSpec): string => renderHelixSourceExpr(spec, HOST.parts, named);

    expect(source({ kind: 'standard', axis: 'z' })).toBe(`'z'`);
    expect(source({ kind: 'axis', producer: 0 })).toBe('spin');
    expect(source({ kind: 'connector', producer: 2, slot: 2 })).toBe('bolt.instance(2)');
    expect(source({ kind: 'edge' })).toBe('axis(e.sideEdges(0))');
    expect(source({ kind: 'face' })).toBe('e.sideEdges(0)');
    expect(renderHelixSourceExpr({ kind: 'axis', producer: 0 }, HOST.parts, unnamed)).toBe('a');
    expect(renderHelixStatement(CHAINS, source({ kind: 'standard', axis: 'z' })))
      .toBe(`helix('z').radius(15).pitch(10).turns(4)`);
  });

  const MODEL = src(
    `import { sketch, circle, extrude, axis, helix } from 'fluidcad/core'`,
    ``,
    `const spin = axis('z', { offsetX: 5 })`,
    `sketch('xy', () => { circle(20) })`,
    `const e = extrude(30)`,
    `helix('z').radius(15).pitch(10)`,
  );

  /** An edit of the helix on line 6 that re-sources it. */
  function sourceEdit(source: unknown, extra: Partial<ApplyFeatureEditSpec> = {}): ApplyFeatureEditSpec {
    return {
      feature: 'helix',
      filePath: '/ws/model.fluid.js',
      producers: [],
      parts: [],
      imports: [],
      edit: { line: 6, column: 0, helix: { ...CHAINS, source } },
      ...extra,
    } as ApplyFeatureEditSpec;
  }

  it('creates a helix on a world axis and on an axis statement', async () => {
    const base = { feature: 'helix' as const, filePath: '/ws/model.fluid.js', parts: [], imports: [] };
    const onAxis = await applyFeatureEdit(MODEL, {
      ...base, producers: [], helix: { ...CHAINS, source: { kind: 'standard', axis: 'y' } },
    });
    expect(onAxis.error).toBeUndefined();
    expect(onAxis.newCode).toContain(`helix('y').radius(15).pitch(10).turns(4)`);

    const onStatement = await applyFeatureEdit(MODEL, {
      ...base, producers: [producer(3, 'axis', 'a')], helix: { ...CHAINS, source: { kind: 'axis', producer: 0 } },
    });
    expect(onStatement.error).toBeUndefined();
    expect(onStatement.newCode).toContain(`helix(spin).radius(15).pitch(10).turns(4)`);
  });

  it('re-sources an edited helix to a picked edge, a picked face and an axis statement', async () => {
    const solid = { producers: [producer(5, 'extrude', 'e')] };

    const edge = await applyFeatureEdit(MODEL, sourceEdit({ kind: 'edge' }, { ...solid, parts: [bucket(0, 'sideEdges', 0)], imports: ['axis'] }));
    expect(edge.error).toBeUndefined();
    expect(edge.newCode).toContain(`helix(axis(e.sideEdges(0))).radius(15).pitch(10).turns(4)\n`);

    const face = await applyFeatureEdit(MODEL, sourceEdit({ kind: 'face' }, { ...solid, parts: [bucket(0, 'sideFaces', 0)] }));
    expect(face.error).toBeUndefined();
    expect(face.newCode).toContain(`helix(e.sideFaces(0)).radius(15).pitch(10).turns(4)\n`);

    const statement = await applyFeatureEdit(MODEL, sourceEdit({ kind: 'axis', producer: 0 }, { producers: [producer(3, 'axis', 'a')] }));
    expect(statement.error).toBeUndefined();
    expect(statement.newCode).toContain(`helix(spin).radius(15).pitch(10).turns(4)\n`);
  });

  it('keeps the source of a helix whose edit names none', async () => {
    const spec = sourceEdit(undefined);
    const kept = await applyFeatureEdit(MODEL, spec);
    expect(kept.error).toBeUndefined();
    expect(kept.newCode).toContain(`helix('z').radius(15).pitch(10).turns(4)\n`);
  });

  it('refuses a helix source that is a plane, a wrong producer or a bad axis', async () => {
    const plane = await applyFeatureEdit(MODEL, sourceEdit({ kind: 'standard-plane', plane: 'xy' }));
    expect(plane.error).toBe('malformed helix edit spec: a helix source is an axis or a face, not a plane');

    const solidAxis = await applyFeatureEdit(MODEL, sourceEdit({ kind: 'axis', producer: 0 }, { producers: [producer(5, 'extrude', 'e')] }));
    expect(solidAxis.error).toBe('malformed helix edit spec: the source references a non-axis producer');

    const badAxis = await applyFeatureEdit(MODEL, sourceEdit({ kind: 'standard', axis: 'q' }));
    expect(badAxis.error).toBe('malformed helix edit spec: bad standard axis');

    const noPart = await applyFeatureEdit(MODEL, sourceEdit({ kind: 'edge' }));
    expect(noPart.error).toBe('malformed helix edit spec: a re-picked source is exactly one part');
  });
});
