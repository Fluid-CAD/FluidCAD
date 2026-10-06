import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { CheckJs } from "../helpers/check-js.js";

// A feature module and the models that use it, type-checked as plain
// JavaScript the way a project's editor checks it (see CheckJs): the types
// come from inference alone, with no JSDoc.

/** Every kind of value, declared once. */
const VALUES_MODULE = `
import { Feature, defineFeature } from 'fluidcad/sdk';

export class Probe extends Feature.with({
  face: { picker: 'face', surface: 'planar' },
  faces: { picker: 'face', multiple: true },
  rims: { picker: 'edge', max: 4 },
  height: { type: 'length', default: 10, min: 0 },
  count: { type: 'integer' },
  turn: { type: 'angle', default: 0 },
  depth: { type: 'length', optional: true },
  through: { type: 'boolean', default: true },
  note: { type: 'text', optional: true },
  size: { type: 'select', default: 'm3', options: [{ label: 'M3', value: 'm3' }, { label: 'M4', value: 'm4' }] },
  pitch: { type: 'select', options: [{ label: 'Fine', value: 0.5 }, { label: 'Coarse', value: 0.7 }] },
  finish: { type: 'select', optional: true, options: [{ label: 'Matte', value: 'matte' }, { label: 'Gloss', value: 'gloss' }] },
  vented: { type: 'boolean' },
  sealed: { type: 'boolean', optional: true },
  around: { picker: 'axis' },
  on: { picker: 'plane', optional: true },
  profile: { picker: 'sketch', implicitDefault: true },
  targets: { picker: 'solid', multiple: true },
  after: { picker: 'feature', optional: true },
}) {
  static id = 'acme.probe';

  buildTool() {
    const { face, faces, rims, height, count, turn, depth, through, note, size, pitch, finish, vented, sealed, around, on, profile, targets, after } = this.values;
    return [];
  }
}

export const probe = defineFeature(Probe, {
  label: 'Probe',
  group: 'create',
  operations: ['add', 'new'],
  call: ['face', 'around', { height: 'height', count: 'count', turn: 'turn', depth: 'depth', through: 'through', note: 'note',
    size: 'size', pitch: 'pitch', finish: 'finish', vented: 'vented', sealed: 'sealed', on: 'on', profile: 'profile', targets: 'targets', after: 'after', rims: 'rims' }, '...faces'],
});
`;

/** A standoff as a project writes it: the shape the docs teach. */
const STANDOFF_MODULE = `
import { Feature, defineFeature } from 'fluidcad/sdk';
import { Primitives } from 'fluidcad/sdk/kernel';

export class Standoff extends Feature.with({
  face: { picker: 'face', label: 'On face', surface: 'planar' },
  height: { type: 'length', default: 10, min: 0 },
  outer: { type: 'length', default: 6, min: 0 },
  hole: { type: 'length', default: 3, min: 0 },
}) {
  static id = 'acme.standoff';

  buildTool() {
    const { height, outer } = this.values;
    const faces = this.facesOf(this.values.face);
    return [Primitives.makeCylinder(outer / 2, height + faces.length)];
  }
}

export const standoff = defineFeature(Standoff, {
  label: 'Standoff',
  group: 'create',
  operations: ['add', 'new'],
  call: ['face', { height: 'height', outer: 'outer', hole: 'hole' }],
});
`;

/** A boss standing at connectors, points and anchors: a picker of several kinds. */
const BOSS_MODULE = `
import { Feature, defineFeature } from 'fluidcad/sdk';
import { Primitives } from 'fluidcad/sdk/kernel';

export class Boss extends Feature.with({
  at: { picker: ['connector', 'point', 'anchor'], multiple: true, anchors: ['center'] },
  pin: { picker: 'connector', optional: true },
  sides: { picker: ['face', 'edge'], multiple: true },
  height: { type: 'length', default: 6 },
}) {
  static id = 'acme.boss';

  buildTool() {
    const { at, pin, sides, height } = this.values;
    const frames = at.map(location => this.frameOf(location));
    const origin = this.pointOf(at[0]);
    return frames.map(() => Primitives.makeCylinder(4 + origin.x * 0 + sides.length * 0 + (pin ? 0 : 0), height));
  }
}

export const boss = defineFeature(Boss, {
  label: 'Boss',
  group: 'create',
  call: ['at', { height: 'height', pin: 'pin', sides: 'sides' }],
});
`;

function errorsOf(check: CheckJs): string[] {
  return check.diagnostics().map(d => `${d.file}:${d.line}: ${d.message}`);
}

describe("a feature module's types, in plain JavaScript", () => {
  it("types each value from its declaration", () => {
    const check = CheckJs.check({ 'probe.feature.js': VALUES_MODULE });

    expect(errorsOf(check)).toEqual([]);
    const types = Object.fromEntries(['face', 'faces', 'rims', 'height', 'count', 'turn', 'depth', 'through', 'note', 'size', 'pitch',
      'finish', 'vented', 'sealed', 'around', 'on', 'profile', 'targets', 'after'].map(name => [name, check.typeOf('probe.feature.js', name)]));
    expect(types).toEqual({
      face: 'ISelection',
      faces: 'ISelection[]',
      rims: 'ISelection[]',
      height: 'number',
      count: 'number',
      turn: 'number',
      depth: 'number | undefined',
      through: 'boolean',
      note: 'string | undefined',
      size: '"m3" | "m4"',
      // A select without a default takes its first option, a boolean false;
      // an optional select without one stays unset.
      pitch: '0.5 | 0.7',
      finish: '"matte" | "gloss" | undefined',
      vented: 'boolean',
      sealed: 'boolean',
      around: 'ISceneObject',
      on: 'ISceneObject | undefined',
      profile: 'ISceneObject | undefined',
      targets: 'ISceneObject[]',
      after: 'ISceneObject | undefined',
    });
  });

  it("types the builder's arguments from the call shape", () => {
    const check = CheckJs.check({ 'probe.feature.js': VALUES_MODULE });

    const builder = check.typeOf('probe.feature.js', 'probe');
    // Positionals in order, the options object (the options a call must pass
    // first), the spread rest value; the feature's own class comes back.
    expect(builder).toMatch(/^\(args_0: ISelection, args_1: (Axis|ISceneObject|StandardAxis)( \| (Axis|ISceneObject|StandardAxis)){2}, args_2: \{ count: number; height\?: number \| undefined; /);
    expect(builder).toMatch(/; \}, \.\.\.args: ISelection\[\]\) => Probe$/);
    expect(builder).toContain('size?: "m3" | "m4" | undefined;');
    // Selects and toggles without a default may be left out too: they resolve to one.
    expect(builder).toContain('pitch?: 0.5 | 0.7 | undefined;');
    expect(builder).toContain('finish?: "matte" | "gloss" | undefined;');
    expect(builder).toContain('vented?: boolean | undefined;');
    expect(builder).toContain('targets?: ISceneObject | ISceneObject[] | undefined;');
    expect(builder).toContain('rims?: ISelection | ISelection[] | undefined;');
    expect(builder).toMatch(/ on\?: (ISceneObject|Plane|StandardPlane)( \| (ISceneObject|Plane|StandardPlane)){2} \| undefined;/);
  });

  it("types location values and pickers of several kinds, and the calls that place them", () => {
    const check = CheckJs.check({
      'boss.feature.js': BOSS_MODULE,
      'plate.part.js': `
import { extrude, connector, part, sketch, circle } from 'fluidcad/core';
import { boss } from './boss.feature.js';

part('plate', () => {
  const plate = extrude(5);
  const bolt = connector('bolt', plate.endFaces());
  const marks = sketch(plate.endFaces(), () => ({ c: circle([10, 0], 4) }));
  boss([bolt, marks.geometries.c.center(), plate.sideFaces().center(), plate.endEdges(0).start()], { height: 8 });
  boss(bolt, { pin: bolt });
  boss(bolt, { height: 'tall' });
});
`,
    });
    expect(errorsOf(check)).toEqual([
      expect.stringContaining(`plate.part.js:11: Type 'string' is not assignable to type 'number'.`),
    ]);
    expect(check.typeOf('boss.feature.js', 'at')).toBe('ISceneObject[]');
    expect(check.typeOf('boss.feature.js', 'pin')).toBe('ISceneObject | undefined');
    expect(check.typeOf('boss.feature.js', 'sides')).toBe('ISelection[]');
    expect(check.typeOf('boss.feature.js', 'origin')).toBe('Point');
  });

  it("types a radio's value as its options' values, as a select's, in the fastener fixture as a project writes it", () => {
    const fixture = fileURLToPath(new URL('../../../server/tests/fixtures/custom-features/fastener.feature.js', import.meta.url));
    const check = CheckJs.check({
      'fastener.feature.js': readFileSync(fixture, 'utf8'),
      'trim.feature.js': `
import { Feature, defineFeature } from 'fluidcad/sdk';

export class Trim extends Feature.with({
  edge: { type: 'radio', options: [{ label: 'Sharp', value: 'sharp' }, { label: 'Round', value: 2 }] },
  finish: { type: 'radio', optional: true, display: 'buttons', options: [{ label: 'Matte', value: 'matte', image: './matte.svg' }] },
}) {
  static id = 'acme.trim';

  buildTool() {
    const { edge, finish } = this.values;
    return [];
  }
}

export const trim = defineFeature(Trim, { label: 'Trim', group: 'create', call: [{ edge: 'edge', finish: 'finish' }] });
`,
      'plate.part.js': `
import { extrude, connector, part } from 'fluidcad/core';
import { fastener } from './fastener.feature.js';
import { trim } from './trim.feature.js';

part('plate', () => {
  const plate = extrude(5);
  const bolt = connector('bolt', plate.endFaces());
  fastener(bolt);
  fastener(bolt, { size: 'n6', head: 'countersink', depth: 4 });
  trim();
  trim({ edge: 2, finish: 'matte' });
  fastener(bolt, { head: 'pan' });
});
`,
    });
    expect(errorsOf(check)).toEqual([
      expect.stringContaining(`plate.part.js:13: Type '"pan"' is not assignable to type '"plain" | "counterbore" | "countersink" | undefined'`),
    ]);
    expect(check.typeOf('fastener.feature.js', 'head')).toBe('"plain" | "counterbore" | "countersink"');
    expect(check.typeOf('fastener.feature.js', 'size')).toBe('"m3" | "m4" | "m5" | "n4" | "n6"');
    // A radio without a default takes its first option; an optional one without one stays unset.
    expect(check.typeOf('trim.feature.js', 'edge')).toBe('2 | "sharp"');
    expect(check.typeOf('trim.feature.js', 'finish')).toBe('"matte" | undefined');
  });

  it("marks a picker of several kinds that names a kind there isn't", () => {
    const check = CheckJs.check({
      'boss.feature.js': BOSS_MODULE.replace("picker: ['connector', 'point', 'anchor']", "picker: ['connector', 'pointy', 'anchor']"),
    });
    expect(errorsOf(check)[0]).toMatch(/^boss\.feature\.js:6: .*Type '"pointy"' is not assignable to type 'PickerKind'/s);
  });

  it("marks a misspelled value in this.values", () => {
    const check = CheckJs.check({
      'standoff.feature.js': STANDOFF_MODULE.replace('const { height, outer } = this.values;', 'const { heigth, outer } = this.values; const height = heigth;'),
    });
    expect(errorsOf(check)).toEqual([
      expect.stringContaining("standoff.feature.js:14: Property 'heigth' does not exist on type"),
    ]);
  });

  it("marks a call shape that names a missing value, and leaves the builder's calls alone", () => {
    const check = CheckJs.check({
      'standoff.feature.js': STANDOFF_MODULE.replace("{ height: 'height', outer", "{ height: 'heigth', outer"),
      'plate.part.js': `
import { extrude } from 'fluidcad/core';
import { standoff } from './standoff.feature.js';
standoff(extrude(5).endFaces(), { height: 12 });
`,
    });
    expect(errorsOf(check)).toEqual([
      `standoff.feature.js:24: Type '"heigth"' is not assignable to type '"face" | "height" | "outer" | "hole"'. Did you mean '"height"'?`,
    ]);
    expect(check.typeOf('standoff.feature.js', 'standoff')).toBe('(...args: unknown[]) => Standoff');
  });

  it("spreads only a list value", () => {
    const check = CheckJs.check({
      'standoff.feature.js': STANDOFF_MODULE.replace("call: ['face', {", "call: ['...face', {"),
    });
    expect(errorsOf(check)).toEqual([
      expect.stringMatching(/^standoff\.feature\.js:24: Type '"\.\.\.face"' is not assignable to type '"face" \| "height" \| "outer" \| "hole" \| \{ readonly \[option: string\]: "face" \| "height" \| "outer" \| "hole"; \}'/),
    ]);
  });

  it("marks metadata the feature can't take", () => {
    const check = CheckJs.check({
      'standoff.feature.js': STANDOFF_MODULE
        .replace("group: 'create',", "group: 'creat', kind: 'tool',")
        .replace("operations: ['add', 'new'],", "operations: ['add', 'cut'],"),
    });
    const errors = errorsOf(check);
    expect(errors).toEqual([
      `standoff.feature.js:22: Type '"creat"' is not assignable to type 'FeatureGroup'. Did you mean '"create"'?`,
      `standoff.feature.js:22: Type 'string' is not assignable to type 'undefined'.`,
      `standoff.feature.js:23: Type '"cut"' is not assignable to type 'FeatureOperation'.`,
    ]);
  });

  it("marks a value spec the dialog can't show", () => {
    const check = CheckJs.check({
      'standoff.feature.js': STANDOFF_MODULE.replace("height: { type: 'length',", "height: { type: 'lenght',"),
    });
    // The first error says what is wrong where it is; the values then type loosely until it is fixed.
    expect(errorsOf(check)[0]).toMatch(/^standoff\.feature\.js:7: .*Type '"lenght"' is not assignable to type '[^']*"length"[^']*'\. Did you mean '"length"'\?$/s);
  });

  it("checks a model's calls against the builder", () => {
    const check = CheckJs.check({
      'standoff.feature.js': STANDOFF_MODULE,
      'probe.feature.js': VALUES_MODULE,
      'plate.part.js': `
import { extrude, select } from 'fluidcad/core';
import { face } from 'fluidcad/filters';
import { standoff } from './standoff.feature.js';
import { probe } from './probe.feature.js';

const plate = extrude(5);
const post = standoff(plate.endFaces(), { height: 12 });
post.new();
standoff(select(face().planar()));
probe(plate.endFaces(), 'z', { count: 3, pitch: 0.7, size: 'm4' }, plate.startFaces(), select(face()));
post.endEdges();

standoff(plate.endFaces(), { heigth: 12 });
standoff(plate);
standoff();
probe(plate.endFaces(), 'z', { count: 3, pitch: 0.7, size: 'm6' });
probe(plate.endFaces(), 'z', { pitch: 0.7 });
`,
    });
    expect(errorsOf(check)).toEqual([
      expect.stringContaining("plate.part.js:14: Object literal may only specify known properties, but 'heigth' does not exist in type"),
      expect.stringContaining("plate.part.js:15: Argument of type 'IExtrude' is not assignable to parameter of type 'ISelection'."),
      expect.stringContaining('plate.part.js:16: Expected 1-2 arguments, but got 0.'),
      expect.stringContaining(`plate.part.js:17: Type '"m6"' is not assignable to type '"m3" | "m4" | undefined'.`),
      expect.stringMatching(/^plate\.part\.js:18: .*Property 'count' is missing in type '\{ pitch: 0\.7; \}'/s),
    ]);
  });
});
