import { describe, it, expect } from "vitest";
import { setupOC } from "../setup.js";
import select from "../../core/select.js";
import extrude from "../../core/extrude.js";
import { face } from "../../filters/index.js";
import { getFeatureMeta, listFeatureExports, registerBuilder, snapshotFeatureMeta } from "../../index.js";
import { SelectSceneObject } from "../../features/select.js";
import { Feature, parseCall, type FeatureMeta, type FeatureBuildContext } from "../../sdk/index.js";
import type { Shape } from "../../sdk/kernel.js";
import * as standoffModule from "../fixtures/custom-features/standoff.js";
import { defineStandoff } from "../fixtures/custom-features/standoff.js";

/** A tool feature class with the given id: it leaves build() to the base. */
function toolClass(id: unknown = 'acme.boss') {
  return class extends Feature {
    static id = id as string;
    buildTool(): Shape[] {
      return [];
    }
  };
}

/** A modifier feature class: it overrides build(). */
class Taper extends Feature {
  static id = 'acme.taper';
  override build(_ctx: FeatureBuildContext): void {}
}

function bossMeta(patch: Record<string, unknown> = {}): FeatureMeta {
  return {
    class: toolClass(),
    label: 'Boss',
    group: 'create',
    kind: 'tool',
    params: {
      face: { picker: 'face', surface: 'planar' },
      height: { type: 'length', default: 5, min: 0 },
    },
    call: ['face', { height: 'height' }],
    ...patch,
  } as FeatureMeta;
}

function taperMeta(patch: Record<string, unknown> = {}): FeatureMeta {
  return {
    class: Taper,
    label: 'Taper',
    group: 'modify',
    kind: 'modifier',
    params: {
      angle: { type: 'angle', default: 5 },
      faces: { picker: 'face', multiple: true },
    },
    call: ['angle', '...faces'],
    ...patch,
  } as FeatureMeta;
}

function register(meta: unknown, options: Record<string, unknown> = {}) {
  return registerBuilder(() => () => undefined, { feature: meta as FeatureMeta, ...options });
}

/** The boss metadata with one value's spec replaced. */
function withParam(name: string, spec: unknown, call: unknown = ['face', { height: 'height' }]) {
  const params = { face: { picker: 'face' }, height: { type: 'length', default: 5 } } as Record<string, unknown>;
  params[name] = spec;
  return bossMeta({ params, call });
}

describe("registerBuilder with feature metadata", () => {
  it("checks the metadata and attaches it to the builder", () => {
    const meta = bossMeta({ operations: ['add', 'new'] });
    const boss = register(meta);
    const attached = getFeatureMeta(boss)!;

    expect(attached.id).toBe('acme.boss');
    expect(attached.class).toBe(meta.class);
    expect(attached.operations).toEqual(['add', 'new']);
    expect(attached.defaultOperation).toBe('add');
    expect(attached.ghost).toBe(true);
    expect(attached.contexts).toEqual(['part']);
    expect(attached.params.height).toEqual({ type: 'length', default: 5, min: 0 });
    expect(Object.isFrozen(attached)).toBe(true);
    expect(Object.isFrozen(attached.params.height)).toBe(true);
    expect(Object.keys(boss)).toEqual([]);
  });

  it("leaves every other builder and value without metadata", () => {
    expect(getFeatureMeta(extrude)).toBeNull();
    expect(getFeatureMeta(registerBuilder(() => () => undefined))).toBeNull();
    for (const value of [undefined, null, 3, 'standoff', {}, () => {}]) {
      expect(getFeatureMeta(value)).toBeNull();
    }
  });

  it("accepts a modifier, and a plain id for the engine's own builders", () => {
    expect(getFeatureMeta(register(taperMeta()))!.kind).toBe('modifier');
    const draftLike = taperMeta({ class: class extends Taper { static id = 'taper'; } });
    expect(getFeatureMeta(register(draftLike, { builtIn: true }))!.id).toBe('taper');
  });

  it("resolves the default operation: add when offered, else the first listed, none without operations", () => {
    const defaultOf = (meta: FeatureMeta) => getFeatureMeta(register(meta))!.defaultOperation;
    expect(defaultOf(bossMeta({ operations: ['new', 'add'] }))).toBe('add');
    expect(defaultOf(bossMeta({ operations: ['remove'] }))).toBe('remove');
    expect(defaultOf(bossMeta({ operations: ['remove', 'new'] }))).toBe('remove');
    expect(defaultOf(bossMeta())).toBeNull();
    expect(defaultOf(taperMeta())).toBeNull();
    expect(snapshotFeatureMeta(bossMeta({ operations: ['remove', 'new'] })).defaultOperation).toBe('remove');
  });
});

describe("feature metadata refusals", () => {
  const refuses = (meta: unknown, message: string | RegExp, options: Record<string, unknown> = {}) =>
    expect(() => register(meta, options)).toThrow(message);

  it("refuse an id that is missing, malformed or without a namespace", () => {
    refuses(bossMeta({ class: toolClass(null) }), /feature metadata: .* needs a static id/);
    for (const id of ['acme..boss', 'acme.', '.boss', '1acme.boss', 'acme boss.x', 'acme/boss.x', 'acme.bo+ss']) {
      refuses(bossMeta({ class: toolClass(id) }), `feature metadata: the id '${id}' is not well formed`);
    }
    refuses(bossMeta({ class: toolClass('boss') }), "feature metadata: the id 'boss' needs a namespace, such as 'acme.boss' — plain ids are the engine's own");
  });

  it("refuse a class that is not a Feature subclass", () => {
    refuses(bossMeta({ class: class { static id = 'acme.boss'; } }), "feature metadata: 'class' must extend Feature from 'fluidcad/sdk'");
    refuses(bossMeta({ class: Feature }), /must extend Feature from 'fluidcad\/sdk', not be Feature itself/);
    refuses(bossMeta({ class: 'acme.boss' }), "feature metadata: 'class' must be the feature's class, got 'acme.boss'");
  });

  it("refuse unknown fields, and an id written beside the class", () => {
    refuses('boss', /the feature is described by an object/);
    refuses(bossMeta({ lable: 'Boss' }), /feature metadata: unknown field 'lable' — the fields are class, label/);
    refuses(bossMeta({ id: 'acme.boss' }), "feature metadata: leave 'id' out — the feature's id is its class's static id");
    refuses(bossMeta({ operations: ['remove', 'new'], defaultOperation: 'new' }),
      "feature metadata: leave 'defaultOperation' out — a feature adds by default when it offers 'add', else it applies the first of its 'operations'");
  });

  it("refuse an illustration or an onChange hook by name: neither is supported, custom controls are planned", () => {
    refuses(bossMeta({ illustration: './boss.svg' }), "feature metadata: leave 'illustration' out — illustrations aren't supported (custom controls are planned)");
    refuses(bossMeta({ onChange: () => undefined }), "feature metadata: leave 'onChange' out — onChange hooks aren't supported (custom controls are planned)");
    // Even left undefined: the field is named, so it is refused rather than passed over.
    refuses(taperMeta({ illustration: undefined }), /leave 'illustration' out/);
    refuses(bossMeta({ lable: 'Boss' }), /the fields are class, label, description, icon, group, kind, operations, params, call, ghost, contexts$/);
  });

  it("refuse an edge value's tangents by name: tangent chains are for fillet and chamfer only", () => {
    refuses(withParam('face', { picker: 'edge', multiple: true, tangents: true }),
      "feature 'acme.boss': param 'face': leave 'tangents' out — tangent chains are for fillet and chamfer only");
    // Even false or undefined, and on a value of several kinds: the field is named, so it is refused rather than passed over.
    refuses(withParam('face', { picker: 'edge', tangents: false }), /param 'face': leave 'tangents' out/);
    refuses(withParam('face', { picker: 'edge', tangents: undefined }), /param 'face': leave 'tangents' out/);
    refuses(withParam('face', { picker: ['edge', 'connector'], multiple: true, tangents: true }), /param 'face': leave 'tangents' out/);
    refuses(withParam('face', { picker: ['point', 'edge'], tangents: false }),
      "feature 'acme.boss': param 'face': leave 'tangents' out — tangent chains are for fillet and chamfer only");
    refuses(withParam('face', { picker: ['point', 'edge'], tangents: undefined }), /param 'face': leave 'tangents' out/);
    refuses(withParam('face', { picker: 'edge', tangent: true }), /unknown field 'tangent' for an edge picker — its fields are .*, curve, facesAsEdges$/);
    // A value that takes no edge never had it: an unknown field, like any other.
    refuses(withParam('face', { picker: 'face', tangents: true }), /param 'face': unknown field 'tangents' for a face picker/);
    refuses(withParam('face', { type: 'length', tangents: true }), /param 'face': unknown field 'tangents' for/);
  });

  it("refuse a missing label, an unknown group or kind", () => {
    refuses(bossMeta({ label: '' }), "feature 'acme.boss': 'label' must be a non-empty string, got ''");
    refuses(bossMeta({ label: undefined }), "feature 'acme.boss': 'label' must be a non-empty string, got nothing");
    refuses(bossMeta({ group: 'sketch' }), "feature 'acme.boss': 'group' must be one of create, modify, got 'sketch'");
    refuses(bossMeta({ kind: 'macro' }), "feature 'acme.boss': 'kind' must be one of tool, modifier, got 'macro'");
  });

  it("refuse a kind its class doesn't build as", () => {
    refuses(bossMeta({ kind: 'modifier' }), /declared kind 'modifier' but its class leaves build\(\) to the base/);
    refuses(taperMeta({ kind: 'tool' }), /declared kind 'tool' but its class overrides build\(\)/);
    refuses(bossMeta({ class: class extends Feature { static id = 'acme.boss'; } }), /declared kind 'tool' but its class implements no buildTool\(\)/);
  });

  it("refuse operations on a modifier, and unknown, repeated or empty ones", () => {
    refuses(taperMeta({ operations: ['add'] }), "feature 'acme.taper': a modifier takes no 'operations' — its build() decides what it does to the solids");
    refuses(bossMeta({ operations: ['add', 'cut'] }), "feature 'acme.boss': 'operations' must be one of add, new, remove, got 'cut'");
    refuses(bossMeta({ operations: ['add', 'add'] }), `feature 'acme.boss': 'operations' lists "add" twice`);
    refuses(bossMeta({ operations: [] }), "feature 'acme.boss': 'operations' must be a non-empty list, got a list");
  });

  it("refuse an unknown picker kind or type, or a value declaring neither or both", () => {
    refuses(withParam('face', { picker: 'vertex' }), /param 'face': unknown picker 'vertex' — the pickers are sketch, face, edge, axis, plane, solid, feature, connector, point, anchor/);
    refuses(withParam('height', { type: 'distance' }), /param 'height': unknown type 'distance' — the types are number, integer, length, angle, boolean, select, text/);
    refuses(withParam('height', { default: 5 }), "feature 'acme.boss': param 'height' declares neither a 'type' nor a 'picker'");
    refuses(withParam('height', { type: 'length', picker: 'face' }), "feature 'acme.boss': param 'height' declares both a 'type' and a 'picker'");
    refuses(withParam('height', 5), /param 'height' must be an object such as \{ type: 'length' \}/);
    refuses(bossMeta({ params: { 'two words': { type: 'length' } }, call: [] }), "feature 'acme.boss': the value name 'two words' is not an identifier");
    refuses(bossMeta({ params: [] }), /'params' must be an object of the feature's values by name, got a list/);
  });

  it("refuse a field the picker kind doesn't have, and a list where one thing is picked", () => {
    refuses(withParam('face', { picker: 'edge', surface: 'planar' }),
      "feature 'acme.boss': param 'face': unknown field 'surface' for an edge picker — its fields are label, description, group, tab, visibleWhen, optional, multiple, max, ordered, curve, facesAsEdges");
    refuses(withParam('face', { picker: 'axis', multiple: true }), "feature 'acme.boss': param 'face': an axis picker picks one axis, so it takes no 'multiple'");
    refuses(withParam('face', { picker: 'plane', ordered: true }), "feature 'acme.boss': param 'face': a plane picker picks one plane, so it takes no 'ordered'");
    refuses(withParam('face', { picker: 'face', default: 'top' }), /param 'face': a picker takes no default/);
    refuses(withParam('face', { picker: 'face', max: 1 }), /param 'face': 'max' must be a whole number of at least 2, got 1/);
    refuses(withParam('face', { picker: 'face', max: 3, multiple: false }), /'max' makes the value a list, so it can't be 'multiple: false'/);
    refuses(withParam('face', { picker: 'face', ordered: true }), /param 'face': only a list can be 'ordered'/);
    refuses(withParam('face', { picker: 'sketch', implicitDefault: true, multiple: true }), /only a single sketch can default to the active one/);
    refuses(withParam('face', { picker: 'face', surface: 'sphere' }), "feature 'acme.boss': param 'face': 'surface' must be one of planar, cylinder, cone, torus, got 'sphere'");
    refuses(withParam('face', { picker: 'edge', curve: 'spline' }), /'curve' must be one of line, circle, arc, got 'spline'/);
    refuses(withParam('face', { picker: 'face', multiple: 'yes' }), "feature 'acme.boss': param 'face': 'multiple' must be true or false, got 'yes'");
    refuses(withParam('face', { picker: 'feature', types: [] }), /param 'face': 'types' must be a non-empty list/);
    refuses(withParam('face', { picker: 'anchor', anchors: ['center', 'middle'] }), /param 'face': 'anchors' must be one of center, start, end, offset, got 'middle'/);
    refuses(withParam('face', { picker: 'face', label: '' }), "feature 'acme.boss': param 'face': 'label' must be a non-empty string, got ''");
  });

  it("refuse an axis picker's connector option by name — every axis picker takes connectors", () => {
    refuses(withParam('face', { picker: 'axis', connector: true }),
      "feature 'acme.boss': param 'face': leave 'connector' out — an axis picker always takes connectors");
    refuses(withParam('face', { picker: 'axis', connector: false }), /param 'face': leave 'connector' out/);
    refuses(withParam('face', { picker: ['axis', 'point'], connector: true }), /leave 'connector' out — an axis picker always takes connectors/);
    refuses(withParam('face', { picker: ['point', 'axis'], connector: false }),
      "feature 'acme.boss': param 'face': leave 'connector' out — an axis picker always takes connectors");
    refuses(withParam('face', { picker: ['point', 'axis'], connector: undefined }), /param 'face': leave 'connector' out/);
    // A kind that never had it: an unknown field, as before.
    refuses(withParam('face', { picker: 'face', connector: true }), /param 'face': unknown field 'connector' for a face picker/);
  });

  it("refuse a typed-in value whose default, range or options don't hold together", () => {
    refuses(withParam('height', { type: 'length', default: 50, min: 0, max: 20 }), "feature 'acme.boss': param 'height': the default (50) is outside 0 to 20");
    refuses(withParam('height', { type: 'length', default: -1, min: 0 }), /the default \(-1\) is outside 0 and up/);
    refuses(withParam('height', { type: 'length', min: 10, max: 2 }), "feature 'acme.boss': param 'height': min (10) is above max (2)");
    refuses(withParam('height', { type: 'number', step: 0 }), /param 'height': step must be above 0, got 0/);
    refuses(withParam('height', { type: 'length', default: '5' }), "feature 'acme.boss': param 'height': 'default' must be a finite number, got '5'");
    refuses(withParam('height', { type: 'length', max: Infinity }), /'max' must be a finite number, got Infinity/);
    refuses(withParam('height', { type: 'integer', default: 2.5 }), "feature 'acme.boss': param 'height': the default of an integer must be a whole number, got 2.5");
    refuses(withParam('height', { type: 'boolean', default: 1 }), /param 'height': the default must be true or false, got 1/);
    refuses(withParam('height', { type: 'text', default: 1 }), /param 'height': the default must be a string, got 1/);
    refuses(withParam('height', { type: 'select', options: [] }), /a select needs 'options', a list of \{ label, value \}/);
    refuses(withParam('height', { type: 'select', options: [{ label: 'A', value: true }] }), /each option is \{ label, value \} with a string or number value/);
    refuses(withParam('height', { type: 'select', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'a' }] }), `feature 'acme.boss': param 'height': 'options' lists "a" twice`);
    refuses(withParam('height', { type: 'select', options: [{ label: 'A', value: 'a' }], default: 'b' }), `feature 'acme.boss': param 'height': the default "b" is not one of its options' values`);
    refuses(withParam('height', { type: 'boolean', min: 0 }), /param 'height': unknown field 'min' for a boolean value — its fields are label, description, group, tab, visibleWhen, optional, default/);
  });

  it("refuse a visibleWhen that names no typed-in value, or a value it can't take", () => {
    const params = (visibleWhen: unknown) => bossMeta({
      params: {
        face: { picker: 'face' },
        style: { type: 'select', options: [{ label: 'Plain', value: 'plain' }, { label: 'Ribbed', value: 'ribbed' }] },
        ribs: { type: 'integer', default: 4, visibleWhen },
      },
      call: ['face', { style: 'style', ribs: 'ribs' }],
    });
    expect(() => register(params({ style: 'ribbed' }))).not.toThrow();
    expect(() => register(params({ style: ['plain', 'ribbed'] }))).not.toThrow();
    refuses(params({ style: 'fluted' }), `feature 'acme.boss': param 'ribs': 'visibleWhen': "fluted" is not a value 'style' can take`);
    refuses(params({ shape: 'x' }), "feature 'acme.boss': param 'ribs': 'visibleWhen' names 'shape', which is not one of the feature's values");
    refuses(params({ ribs: 3 }), "feature 'acme.boss': param 'ribs': 'visibleWhen' names the value itself");
    refuses(params({ face: 'top' }), "feature 'acme.boss': param 'ribs': 'visibleWhen' names 'face', a picked value — it can only name a typed-in one");
    refuses(params({ style: [] }), /the values listed for 'style' are empty/);
    refuses(params({}), /'visibleWhen' must be an object of values to match/);
  });

  it("refuse a call shape that names a missing value or leaves one out", () => {
    refuses(bossMeta({ call: ['face', { height: 'heigth' }] }), "feature 'acme.boss': the call shape names 'heigth', which is not one of the feature's values");
    refuses(bossMeta({ call: ['face'] }), "feature 'acme.boss': the value 'height' has no place in the call shape");
    refuses(bossMeta({ call: ['height', '...face'] }), "feature 'acme.boss': the rest value '...face' must be a list — a picker with 'multiple: true'");
    refuses(bossMeta({ call: ['...face', 'height'] }), "feature 'acme.boss': the rest value '...face' must come last in the call shape");
    refuses(bossMeta({ call: undefined }), /feature 'acme\.boss': the call shape must be a list of slots/);
  });

  it("refuse an icon outside the module's directory or of the wrong kind", () => {
    for (const icon of ['/abs/boss.svg', '../boss.svg', 'icons/../../boss.svg', 'https://example.com/boss.svg', 'data:image/svg+xml,<svg/>', 'icons\\boss.svg', 'icons//boss.svg']) {
      refuses(bossMeta({ icon }), `feature 'acme.boss': 'icon' must be a relative path inside the module's directory, such as './icon.svg', got '${icon}'`);
    }
    refuses(bossMeta({ icon: './boss.gif' }), "feature 'acme.boss': 'icon' must be an image (.svg, .png, .jpg or .webp), got './boss.gif'");
    expect(() => register(bossMeta({ icon: './icons/boss.svg' }))).not.toThrow();
  });

  it("refuse a ghost that is not a flag, and contexts beyond parts", () => {
    refuses(bossMeta({ ghost: 'yes' }), "feature 'acme.boss': 'ghost' must be true or false, got 'yes'");
    refuses(bossMeta({ contexts: ['assembly'] }), "feature 'acme.boss': custom features run in parts only for now — 'contexts' takes 'part'");
    refuses(bossMeta({ contexts: ['sketch'] }), "feature 'acme.boss': 'contexts' must be one of part, got 'sketch'");
    refuses(bossMeta(), "feature 'acme.boss': a feature runs where its 'contexts' say — leave allowAssemblyTopLevel out", { allowAssemblyTopLevel: true });
  });
});

describe("feature discovery", () => {
  it("finds the builders a module exports", () => {
    const found = listFeatureExports(standoffModule);
    expect(found.map(entry => entry.exportName)).toEqual(['standoff']);
    expect(found[0].meta.id).toBe('acme.standoff');
    expect(found[0].meta.class).toBe(standoffModule.Standoff);
  });

  it("lists a builder once, leaves out the default export and everything that is no feature builder", () => {
    const { standoff } = defineStandoff();
    const taper = register(taperMeta());
    const namespace = {
      default: taper,
      so: standoff,
      standoff,
      taper,
      extrude,
      helper: () => 1,
      SIZE: 4,
      get pending(): unknown {
        throw new ReferenceError("Cannot access 'pending' before initialization");
      },
    };
    expect(listFeatureExports(namespace).map(entry => [entry.exportName, entry.meta.id]))
      .toEqual([['so', 'acme.standoff'], ['taper', 'acme.taper']]);
  });
});

describe("a feature metadata snapshot", () => {
  /** Every function anywhere in a value. */
  function functionsIn(value: unknown): unknown[] {
    if (typeof value === 'function') {
      return [value];
    }
    if (value !== null && typeof value === 'object') {
      return Object.values(value).flatMap(functionsIn);
    }
    return [];
  }

  it("is plain JSON: the class becomes its id", () => {
    const { standoff } = defineStandoff();
    const snapshot = snapshotFeatureMeta(getFeatureMeta(standoff)!);

    expect(functionsIn(snapshot)).toEqual([]);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(snapshot).toEqual({
      id: 'acme.standoff',
      label: 'Standoff',
      description: 'A boss with a bore through it, standing on a planar face',
      icon: './standoff.svg',
      group: 'create',
      kind: 'tool',
      operations: ['add', 'new'],
      defaultOperation: 'add',
      params: {
        face: { picker: 'face', label: 'On face', surface: 'planar' },
        height: { type: 'length', default: 10, min: 0, label: 'Height' },
        outer: { type: 'length', default: 6, min: 0, label: 'Boss diameter' },
        hole: { type: 'length', default: 3, min: 0, label: 'Hole diameter' },
      },
      call: ['face', { height: 'height', outer: 'outer', hole: 'hole' }],
      ghost: true,
      contexts: ['part'],
    });
    expect(Object.keys(snapshot.params)).toEqual(['face', 'height', 'outer', 'hole']);
  });

  it("reads metadata nobody checked yet", () => {
    const meta = taperMeta({
      ghost: false,
      params: { angle: { type: 'angle', default: 5 }, draftFaces: { picker: 'face', multiple: true } },
      call: ['angle', '...draftFaces'],
    });
    const snapshot = snapshotFeatureMeta(meta);
    expect(functionsIn(snapshot)).toEqual([]);
    expect(snapshot).toMatchObject({ id: 'acme.taper', ghost: false, operations: [], defaultOperation: null, contexts: ['part'] });
    expect(snapshot.params.draftFaces.label).toBe('Draft faces');
    expect(snapshotFeatureMeta(getFeatureMeta(register(meta))!)).toEqual(snapshot);
  });
});

describe("parseCall", () => {
  setupOC();

  const sel = () => select(face().planar()) as unknown as SelectSceneObject;

  it("reads a rest value into a list, and fills every declared value", () => {
    const meta = taperMeta();
    const [a, b] = [sel(), sel()];
    expect(parseCall(meta, [3, a, b])).toEqual({ angle: 3, faces: [a, b] });
    expect(Object.keys(parseCall(meta, [undefined, a]))).toEqual(['angle', 'faces']);
    expect(parseCall(meta, [undefined, a]).angle).toBe(5);
    expect(() => parseCall(meta, [3])).toThrow("taper(): 'faces' is required — pick at least one face");
    expect(() => parseCall(meta, [3, a, 'b'])).toThrow(/taper\(\): each of 'faces' must be a scene object .*, got 'b'/);
  });

  it("reads by the shape alone when given only a shape", () => {
    expect(parseCall(['angle', '...faces'], [3, 'a', 'b'])).toEqual({ angle: 3, faces: ['a', 'b'] });
  });

  it("checks each typed-in value against its declaration", () => {
    const meta = bossMeta({
      params: {
        face: { picker: 'face', optional: true },
        count: { type: 'integer', default: 2, min: 1, max: 6 },
        style: { type: 'select', options: [{ label: 'Plain', value: 'plain' }, { label: 'Round', value: 2 }] },
        hollow: { type: 'boolean', default: false },
        tag: { type: 'text', optional: true },
      },
      call: ['face', { count: 'count', style: 'style', hollow: 'hollow', tag: 'tag' }],
    });
    expect(parseCall(meta, [undefined, { style: 2 }])).toEqual({ face: undefined, count: 2, style: 2, hollow: false, tag: undefined });
    expect(parseCall(meta, [null, { style: 'plain', count: null, tag: null }])).toEqual({ face: null, count: 2, style: 'plain', hollow: false, tag: null });
    // A select without a default takes its first option.
    expect(parseCall(meta, [undefined, {}])).toEqual({ face: undefined, count: 2, style: 'plain', hollow: false, tag: undefined });
    expect(() => parseCall(meta, [undefined, { style: 'round' }])).toThrow(`boss(): 'style' must be one of "plain", 2, got 'round'`);
    expect(() => parseCall(meta, [undefined, { style: 2, count: 1.5 }])).toThrow("boss(): 'count' must be a whole number, got 1.5");
    expect(() => parseCall(meta, [undefined, { style: 2, count: 7 }])).toThrow("boss(): 'count' must be at most 6, got 7");
    expect(() => parseCall(meta, [undefined, { style: 2, hollow: 'no' }])).toThrow("boss(): 'hollow' must be true or false, got 'no'");
    expect(() => parseCall(meta, [undefined, { style: 2, tag: 4 }])).toThrow("boss(): 'tag' must be a string, got 4");
    expect(() => parseCall(meta, [[sel()], { style: 2 }])).toThrow("boss(): 'face' must be a scene object (a selection, a sketch, a feature), got a list");
  });

  it("makes one scene object passed for a list a list of one, and holds a list to its max", () => {
    const meta = bossMeta({
      params: { faces: { picker: 'face', max: 2 }, height: { type: 'length', default: 5 } },
      call: ['faces', { height: 'height' }],
    });
    const [a, b, c] = [sel(), sel(), sel()];
    expect(parseCall(meta, [a]).faces).toEqual([a]);
    expect(parseCall(meta, [[a, b]]).faces).toEqual([a, b]);
    expect(() => parseCall(meta, [[a, b, c]])).toThrow("boss(): 'faces' takes at most 2, got 3");
  });

  it("lets a single sketch that defaults to the active one be left out", () => {
    const meta = bossMeta({
      params: { profile: { picker: 'sketch', implicitDefault: true }, height: { type: 'length', default: 5 } },
      call: ['height', 'profile'],
    });
    expect(parseCall(meta, [4])).toEqual({ profile: undefined, height: 4 });
  });

  it("claims the selections a feature call hands over in a list or its object of options", () => {
    const Span = toolClass('acme.span');
    const meta = bossMeta({
      class: Span,
      params: { height: { type: 'length', default: 5 }, along: { picker: 'face', multiple: true } },
      call: ['height', { along: 'along' }],
    });
    const span = registerBuilder(context => (...args: unknown[]) => new Span(parseCall(meta, args)).addTo(context), { feature: meta });
    const [a, b] = [sel(), sel()];
    span(4, { along: [a, b] });
    expect([a.isClaimed(), b.isClaimed()]).toEqual([true, true]);
  });
});

describe("a value the call leaves out", () => {
  const OPTIONS = [{ label: 'Plain', value: 'plain' }, { label: 'Round', value: 2 }];

  /** Every typed-in type with no default, required and optional, and two that declare one. */
  const PARAMS = {
    flag: { type: 'boolean' },
    quiet: { type: 'boolean', optional: true },
    lit: { type: 'boolean', default: true },
    style: { type: 'select', options: OPTIONS },
    finish: { type: 'select', options: OPTIONS, optional: true },
    shape: { type: 'select', options: OPTIONS, default: 2 },
    picked: { type: 'select', options: OPTIONS, default: 2, optional: true },
    count: { type: 'number' },
    holes: { type: 'integer', optional: true },
    depth: { type: 'length' },
    lip: { type: 'length', optional: true },
    turn: { type: 'angle' },
    tilt: { type: 'angle', optional: true },
    note: { type: 'text' },
    tag: { type: 'text', optional: true },
  } as const;

  function meta(params: Record<string, unknown> = PARAMS): FeatureMeta {
    return bossMeta({
      class: toolClass('acme.trim'),
      params: { face: { picker: 'face', optional: true }, ...params },
      call: ['face', Object.fromEntries(Object.keys(params).map(name => [name, name]))],
    });
  }

  /** What each value resolves to when left out: false, a select's first option, a declared default — else nothing. */
  const RESOLVED = { flag: false, quiet: false, lit: true, style: 'plain', shape: 2, picked: 2 };

  it("resolves a boolean to false and a select to its first option — an optional select stays unset, a number or a text too", () => {
    const resolved = getFeatureMeta(register(meta()))!;
    const defaults = Object.fromEntries(Object.entries(resolved.params).map(([name, spec]) => [name, (spec as { default?: unknown }).default]));
    expect(defaults).toEqual({
      face: undefined, ...RESOLVED, finish: undefined,
      count: undefined, holes: undefined, depth: undefined, lip: undefined, turn: undefined, tilt: undefined, note: undefined, tag: undefined,
    });
    // The declared fields stay as they are; only the default is filled in.
    expect(resolved.params.style).toEqual({ type: 'select', options: OPTIONS, default: 'plain' });
    expect(resolved.params.quiet).toEqual({ type: 'boolean', optional: true, default: false });
    expect(Object.isFrozen(resolved.params.flag)).toBe(true);
  });

  it("is what the snapshot carries, checked or not", () => {
    const fromChecked = snapshotFeatureMeta(getFeatureMeta(register(meta()))!);
    const fromUnchecked = snapshotFeatureMeta(meta());
    expect(fromUnchecked).toEqual(fromChecked);
    for (const [name, value] of Object.entries(RESOLVED)) {
      expect([name, (fromChecked.params[name] as { default?: unknown }).default]).toEqual([name, value]);
    }
    for (const name of ['face', 'finish', 'count', 'holes', 'depth', 'lip', 'turn', 'tilt', 'note', 'tag']) {
      expect([name, 'default' in fromChecked.params[name]]).toEqual([name, false]);
    }
  });

  it("is what the builder fills for a value left out or null — a number or a text without a default stays required, or unset when optional", () => {
    const optionalOnly = meta(Object.fromEntries(Object.entries(PARAMS).filter(([name]) => !['count', 'depth', 'turn', 'note'].includes(name))));
    const left = { face: undefined, ...RESOLVED, finish: undefined, holes: undefined, lip: undefined, tilt: undefined, tag: undefined };
    expect(parseCall(optionalOnly, [])).toEqual(left);
    expect(parseCall(optionalOnly, [undefined, { flag: null, style: null, lit: null }])).toEqual(left);
    expect(parseCall(optionalOnly, [undefined, { flag: true, style: 2, finish: 'plain', quiet: true }]))
      .toMatchObject({ flag: true, style: 2, finish: 'plain', quiet: true });

    const full = meta();
    const required = { count: 1, depth: 2, turn: 3, note: 'n' };
    expect(parseCall(full, [undefined, required])).toEqual({ ...left, ...required });
    for (const name of Object.keys(required)) {
      const without = Object.fromEntries(Object.entries(required).filter(([other]) => other !== name));
      expect(() => parseCall(full, [undefined, without])).toThrow(`trim(): '${name}' is required`);
    }
  });
});
