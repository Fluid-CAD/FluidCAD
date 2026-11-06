import { describe, it, expect } from 'vitest';
import path from 'path';
import { CheckJs } from '../../lib/tests/helpers/check-js.js';

// The JavaScript standoff is the file a project keeps as standoff.feature.js:
// under the checkJs jsconfig `fluidcad init` writes, it and a model that uses
// it must show no red underlines, with every type inferred.

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures/custom-features/standoff.feature.js');
const BOSS = path.resolve(import.meta.dirname, 'fixtures/custom-features/boss.feature.js');

describe('the JavaScript standoff fixture, type-checked as a project checks it', () => {
  it('has no errors, its values and its builder typed by inference alone', () => {
    const check = CheckJs.check({}, [FIXTURE]);

    expect(check.diagnostics()).toEqual([]);
    expect(['height', 'outer', 'hole'].map(name => check.typeOf('standoff.feature.js', name))).toEqual(['number', 'number', 'number']);
    expect(check.typeOf('standoff.feature.js', 'standoff')).toBe(
      '(args_0: ISelection, args_1?: { height?: number | undefined; outer?: number | undefined; hole?: number | undefined; } | undefined) => Standoff',
    );
  });

  it('types a model that places, fillets and repeats it, and marks a misspelled option', () => {
    const fixture = path.relative(path.resolve(import.meta.dirname, '../../lib/tests/.check-js'), FIXTURE);
    const check = CheckJs.check({
      'plate.part.js': `
import { extrude, fillet, repeat } from 'fluidcad/core';
import { standoff } from '${fixture}';

const pad = extrude(4);
const post = standoff(pad.endFaces(), { outer: 6, hole: 3.2 });
const rim = fillet(0.5, post.endEdges());
repeat('linear', 'x', { count: 2, offset: 20 }, pad, post.new(), rim);
standoff(pad.endFaces(), { hieght: 8 });
`,
    }, [FIXTURE]);

    expect(check.diagnostics().map(d => `${d.file}:${d.line}: ${d.message}`)).toEqual([
      expect.stringContaining("plate.part.js:9: Object literal may only specify known properties, but 'hieght' does not exist in type"),
    ]);
  });

  it('has no errors in the boss either, and types a model that stands it at a connector, a point and an anchor', () => {
    const boss = path.relative(path.resolve(import.meta.dirname, '../../lib/tests/.check-js'), BOSS);
    const check = CheckJs.check({
      'plate.part.js': `
import { extrude, connector, part, sketch, circle, copy } from 'fluidcad/core';
import { boss } from '${boss}';

part('plate', () => {
  const plate = extrude(5);
  const bolt = connector('bolt', plate.endFaces());
  copy('linear', 'x', { count: 2, offset: 20 }, bolt);
  const marks = sketch(plate.endFaces(), () => ({ c: circle([10, 0], 4) }));
  boss([bolt, bolt.instance(1), marks.geometries.c.center(), plate.sideFaces().center()], { height: 8 });
  boss(bolt, { hieght: 8 });
});
`,
    }, [BOSS]);

    expect(check.diagnostics().map(d => `${d.file}:${d.line}: ${d.message}`)).toEqual([
      expect.stringContaining("plate.part.js:11: Object literal may only specify known properties, but 'hieght' does not exist in type"),
    ]);
    expect(check.typeOf('boss.feature.js', 'at')).toBe('ISceneObject[]');
  });
});

describe('the JavaScript gear fixture, whose class declares buckets, type-checked as a project checks it', () => {
  const GEAR = path.resolve(import.meta.dirname, 'fixtures/custom-features/gear.feature.js');

  function errorsOf(check: CheckJs): string[] {
    return check.diagnostics().map(d => `${d.file}:${d.line}: ${d.message}`);
  }

  it('has no errors, its builder typed as the class with its bucket accessors', () => {
    const check = CheckJs.check({}, [GEAR]);

    expect(check.diagnostics()).toEqual([]);
    expect(check.typeOf('gear.feature.js', 'gear')).toBe(
      '(args_0: ISelection, args_1?: { teeth?: number | undefined; module?: number | undefined; thickness?: number | undefined; bore?: number | undefined; } | undefined) => Gear',
    );
  });

  it('types a model that rounds the tips, picks the flanks and reaches a copy\'s tips, and marks a misspelled accessor', () => {
    const gear = path.relative(path.resolve(import.meta.dirname, '../../lib/tests/.check-js'), GEAR);
    const check = CheckJs.check({
      'gearbox.part.js': `
import { extrude, fillet, chamfer, repeat } from 'fluidcad/core';
import { edge, face } from 'fluidcad/filters';
import { gear } from '${gear}';

const plate = extrude(6);
const g = gear(plate.endFaces(), { teeth: 18 });
const tips = g.tipEdges();
const flanks = g.flankFaces(face().planar());
fillet(0.3, g.tipEdges(edge().convex()));
const r = repeat('circular', 'z', { count: 3, angle: 360 }, g);
const copyTips = r.instance(1).tipEdges();
chamfer(0.5, r.instance(2).boreEdges(0));
g.tipEdge();
`,
    }, [GEAR]);

    expect(errorsOf(check)).toEqual([
      expect.stringMatching(/^gearbox\.part\.js:14: Property 'tipEdge' does not exist on type 'Gear'\. Did you mean 'tipEdges'\?/),
    ]);
    expect(['tips', 'flanks', 'copyTips'].map(name => check.typeOf('gearbox.part.js', name))).toEqual(['ISelection', 'ISelection', 'ISelection']);
  });

  it('marks a misspelled bucket in the feature\'s own setBuckets()', () => {
    const check = CheckJs.check({
      'sprocket.feature.js': `
import { Feature, defineFeature } from 'fluidcad/sdk';
import { Primitives } from 'fluidcad/sdk/kernel';

class Sprocket extends Feature.with({ size: { type: 'length', default: 10 } }, { buckets: { tipFaces: {}, tipEdges: {} } }) {
  static id = 'sprocket';
  buildTool() {
    const disc = Primitives.makeCylinder(this.values.size, 2);
    this.setBuckets({ tipFace: [] });
    return [disc];
  }
}
export const sprocket = defineFeature(Sprocket, { label: 'Sprocket', group: 'create', call: ['size'] });
`,
    });

    expect(errorsOf(check)).toEqual([
      expect.stringMatching(/^sprocket\.feature\.js:9: Object literal may only specify known properties, .*'tipFace'/),
    ]);
  });
});

describe('the JavaScript raw OpenCascade fixtures, type-checked as a project checks them', () => {
  const TWIST = path.resolve(import.meta.dirname, 'fixtures/custom-features/twist.feature.js');
  const DANGLING = path.resolve(import.meta.dirname, 'fixtures/custom-features/dangling.feature.js');

  it('types the twist\'s raw code through its scope, the binding\'s classes and all', () => {
    const check = CheckJs.check({}, [TWIST, DANGLING]);

    expect(check.diagnostics()).toEqual([]);
    expect(['height', 'angle', 'sections', 'bore'].map(name => check.typeOf('twist.feature.js', name))).toEqual(['number', 'number', 'number', 'number']);
    expect(check.typeOf('twist.feature.js', 'loft')).toBe('BRepOffsetAPI_ThruSections');
    expect(check.typeOf('twist.feature.js', 'section')).toBe('TopoDS_Shape');
    expect(check.typeOf('twist.feature.js', 'twist')).toBe(
      '(args_0: ISelection, args_1?: { height?: number | undefined; angle?: number | undefined; sections?: number | undefined; bore?: number | undefined; } | undefined) => Twist',
    );
  });

  it('marks a misspelled class of the binding', () => {
    const check = CheckJs.check({
      'knurl.feature.js': `
import { Feature, defineFeature } from 'fluidcad/sdk';
import { ShapeFactory } from 'fluidcad/sdk/kernel';

class Knurl extends Feature.with({ size: { type: 'length', default: 2 } }) {
  static id = 'acme.knurl';
  buildTool() {
    return this.occ(({ oc }) => [ShapeFactory.fromShape(new oc.BRepPrimAPI_MakeCylindr(this.values.size, 4).Shape())]);
  }
}
export const knurl = defineFeature(Knurl, { label: 'Knurl', group: 'create', call: ['size'] });
`,
    });

    expect(check.diagnostics().map(d => `${d.file}:${d.line}: ${d.message}`)).toEqual([
      expect.stringContaining("knurl.feature.js:8: Property 'BRepPrimAPI_MakeCylindr' does not exist on type 'OpenCascadeInstance'. Did you mean 'BRepPrimAPI_MakeCylinder'?"),
    ]);
  });
});
