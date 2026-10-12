import { describe, it, expect } from "vitest";
import { setupOC } from "../setup.js";
import select from "../../core/select.js";
import extrude from "../../core/extrude.js";
import { face } from "../../filters/index.js";
import { getFeatureMeta, listFeatureAssets, listFeatureExports, registerBuilder, snapshotFeatureMeta } from "../../index.js";
import { SelectSceneObject } from "../../features/select.js";
import { Feature, parseCall, type FeatureMeta, type FeatureBuildContext } from "../../sdk/index.js";
import type { Shape } from "../../sdk/kernel.js";
import * as standoffModule from "../fixtures/custom-features/standoff.js";
import { defineStandoff } from "../fixtures/custom-features/standoff.js";
import { defineFastener } from "../fixtures/custom-features/fastener.js";
import { FeatureMetas } from "../../sdk/meta.js";

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

  it("refuse an id that is missing, malformed or one of the engine's own types", () => {
    refuses(bossMeta({ class: toolClass(null) }), /feature metadata: .* needs a static id/);
    for (const id of ['acme..boss', 'acme.', '.boss', '1acme.boss', 'acme boss.x', 'acme/boss.x', 'acme.bo+ss', '@acme/kit:boss', 'kit:boss']) {
      refuses(bossMeta({ class: toolClass(id) }), `feature metadata: the id '${id}' is not well formed`);
    }
    for (const id of ['extrude', 'part', 'feature', 'fillet2d', 'distance', 'draft']) {
      refuses(bossMeta({ class: toolClass(id) }), `feature metadata: '${id}' is one of the engine's own types: give the feature another id`);
    }
  });

  it("accept a plain id, and a dotted one", () => {
    expect(getFeatureMeta(register(bossMeta({ class: toolClass('boss') })))!.id).toBe('boss');
    expect(getFeatureMeta(register(bossMeta({ class: toolClass('acme.boss') })))!.id).toBe('acme.boss');
    expect(getFeatureMeta(register(bossMeta({ class: toolClass('acme.extrude') })))!.id).toBe('acme.extrude');
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
    refuses(bossMeta({ lable: 'Boss' }), /the fields are class, label, description, icon, group, kind, operations, params, call, ghost, contexts, layout, width, aside$/);
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
    refuses(withParam('height', { type: 'distance' }), /param 'height': unknown type 'distance' — the types are number, integer, length, angle, boolean, select, radio, text/);
    refuses(withParam('height', { default: 5 }), "feature 'acme.boss': param 'height' declares neither a 'type' nor a 'picker'");
    refuses(withParam('height', { type: 'length', picker: 'face' }), "feature 'acme.boss': param 'height' declares both a 'type' and a 'picker'");
    refuses(withParam('height', 5), /param 'height' must be an object such as \{ type: 'length' \}/);
    refuses(bossMeta({ params: { 'two words': { type: 'length' } }, call: [] }), "feature 'acme.boss': the value name 'two words' is not an identifier");
    refuses(bossMeta({ params: [] }), /'params' must be an object of the feature's values by name, got a list/);
  });

  it("refuse a field the picker kind doesn't have, and a list where one thing is picked", () => {
    refuses(withParam('face', { picker: 'edge', surface: 'planar' }),
      "feature 'acme.boss': param 'face': unknown field 'surface' for an edge picker — its fields are label, description, group, tab, hint, aside, visibleWhen, optional, multiple, max, ordered, curve, facesAsEdges");
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
    refuses(withParam('height', { type: 'boolean', min: 0 }), /param 'height': unknown field 'min' for a boolean value — its fields are label, description, group, tab, hint, aside, visibleWhen, optional, default/);
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
    // A picked value takes a condition: picked or not, its faces' surface, or the opposite of one.
    expect(() => register(params({ face: { picked: true } }))).not.toThrow();
    expect(() => register(params({ face: { surface: ['planar', 'cone'] } }))).not.toThrow();
    expect(() => register(params({ face: { not: { surface: 'cylinder' } }, style: 'ribbed' }))).not.toThrow();
    refuses(params({ face: 'top' }), "feature 'acme.boss': param 'ribs': 'visibleWhen': 'face' is a picked value: give it a condition such as { picked: true } or { surface: 'cylinder' }, got 'top'");
    refuses(params({ face: { picked: 'yes' } }), "feature 'acme.boss': param 'ribs': 'visibleWhen': 'face': 'picked' must be true or false, got 'yes'");
    refuses(params({ face: { surface: 'cube' } }), /'face': 'surface' takes 'planar', 'cylinder', 'cone', 'sphere', 'torus', 'other', got 'cube'/);
    refuses(params({ face: { not: { surface: [] } } }), "feature 'acme.boss': param 'ribs': 'visibleWhen': 'face': 'not': the surfaces listed are empty");
    refuses(params({ face: { kind: 'face' } }), "feature 'acme.boss': param 'ribs': 'visibleWhen': 'face': unknown field 'kind' — a picked value's condition takes 'picked', 'surface' and 'not'");
    refuses(params({ style: [] }), /the values listed for 'style' are empty/);
    refuses(params({}), /'visibleWhen' must be an object of values to match/);
  });

  it("tell picked values apart by what they hold", () => {
    expect(FeatureMetas.pickHolds({ picked: true }, [])).toBe(false);
    expect(FeatureMetas.pickHolds({ picked: false }, [])).toBe(true);
    expect(FeatureMetas.pickHolds({ picked: true }, [null])).toBe(true);
    // Every pick must be a face of the surface; nothing picked is no surface.
    expect(FeatureMetas.pickHolds({ surface: 'cylinder' }, ['cylinder', 'cylinder'])).toBe(true);
    expect(FeatureMetas.pickHolds({ surface: 'cylinder' }, ['cylinder', 'planar'])).toBe(false);
    expect(FeatureMetas.pickHolds({ surface: ['cylinder', 'cone'] }, ['cone'])).toBe(true);
    expect(FeatureMetas.pickHolds({ surface: 'cylinder' }, [])).toBe(false);
    expect(FeatureMetas.pickHolds({ surface: 'cylinder' }, [null])).toBe(false);
    // `not` holds while nothing is picked, an axis is, or another surface is.
    for (const picks of [[], [null], ['planar']] as const) {
      expect(FeatureMetas.pickHolds({ not: { surface: 'cylinder' } }, picks)).toBe(true);
    }
    expect(FeatureMetas.pickHolds({ not: { surface: 'cylinder' } }, ['cylinder'])).toBe(false);
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
      // No layout of its own, no group, no tab: the derived one is its values in order.
      layout: ['face', 'height', 'outer', 'hole'],
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

  it("reads a call that goes straight to its options when the positionals it skips may be left out", () => {
    const gear = bossMeta({
      params: {
        at: { picker: ['face', 'edge'], optional: true },
        turn: { type: 'angle', default: 0 },
        teeth: { type: 'integer', default: 24, min: 3 },
      },
      call: ['at', 'turn', { teeth: 'teeth' }],
    });
    expect(parseCall(gear, [{ teeth: 30 }])).toEqual({ at: undefined, turn: 0, teeth: 30 });
    expect(parseCall(gear, [])).toEqual({ at: undefined, turn: 0, teeth: 24 });
    expect(parseCall(gear, [undefined, undefined, { teeth: 30 }])).toEqual({ at: undefined, turn: 0, teeth: 30 });
    expect(parseCall(gear, [sel(), 15, { teeth: 30 }]).turn).toBe(15);
    expect(parseCall(gear, [sel(), { teeth: 30 }]).turn).toBe(0);

    // A positional that must be given still must: skipping it says where it goes.
    expect(() => parseCall(bossMeta(), [{ height: 5 }])).toThrow("boss(): 'face' is required — it comes before the options");
    expect(() => parseCall(bossMeta({
      params: { face: { picker: 'face', optional: true }, depth: { type: 'length' }, height: { type: 'length', default: 5 } },
      call: ['face', 'depth', { height: 'height' }],
    }), [{ height: 5 }])).toThrow("boss(): 'depth' is required — it comes before the options");
    expect(() => parseCall(bossMeta(), [undefined, { height: 5 }])).toThrow("boss(): 'face' is required");
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

describe("dependent options: an option's 'when'", () => {
  const STANDARD = { type: 'radio', options: [{ label: 'Metric', value: 'iso' }, { label: 'Imperial', value: 'unc' }] };
  const sized = (patch: Record<string, unknown> = {}, iso: unknown = { standard: 'iso' }) => ({
    type: 'select',
    options: [{ label: 'M3', value: 'm3', when: iso }, { label: '#4', value: 'n4', when: { standard: 'unc' } }, { label: 'Custom', value: 'custom' }],
    ...patch,
  });
  /** The boss with further typed-in values, all in its options object. */
  const meta = (extra: Record<string, unknown>) => bossMeta({
    params: { face: { picker: 'face', optional: true }, height: { type: 'length', default: 5 }, ...extra },
    call: ['face', Object.fromEntries(['height', ...Object.keys(extra)].map(name => [name, name]))],
  });
  const refuses = (extra: Record<string, unknown>, message: string) =>
    expect(() => register(meta(extra))).toThrow(`feature 'acme.boss': ${message}`);
  const resolved = (extra: Record<string, unknown>) => getFeatureMeta(register(meta(extra)))!;
  const dependent = (name: string, on: string) => ({ type: 'select', optional: true, options: [{ label: 'A', value: 'a', when: { [on]: 'a' } }], label: name });

  it("refuses a clause as 'visibleWhen' refuses it, naming the option", () => {
    const at = `param 'size': option "m3": 'when'`;
    refuses({ standard: STANDARD, size: sized({}, { standrd: 'iso' }) }, `${at} names 'standrd', which is not one of the feature's values`);
    refuses({ standard: STANDARD, size: sized({}, { face: 'iso' }) }, `${at} names 'face', a picked value — it can only name a typed-in one`);
    refuses({ standard: { type: 'select', multiple: true, options: STANDARD.options }, size: sized() },
      `${at} names 'standard', a select with 'multiple: true' — it can only name a value that holds one thing`);
    refuses({ standard: STANDARD, size: sized({}, { size: 'custom' }) }, `${at} names the value itself`);
    refuses({ standard: STANDARD, size: sized({}, { standard: 'din' }) }, `${at}: "din" is not a value 'standard' can take`);
    refuses({ standard: STANDARD, size: sized({}, { standard: [] }) }, `${at}: the values listed for 'standard' are empty`);
    refuses({ standard: STANDARD, size: sized({}, {}) }, `${at} must be an object of values to match`);
  });

  it("refuses options that wait on each other, naming the circle", () => {
    refuses({ a: dependent('A', 'b'), b: dependent('B', 'a') },
      `param 'a': the 'when' of its options comes back round to it (a → b → a) — options that wait on each other have no first one to offer`);
    refuses({ a: dependent('A', 'b'), b: dependent('B', 'c'), c: dependent('C', 'a') }, `param 'a': the 'when' of its options comes back round to it (a → b → c → a)`);
    expect(() => register(meta({ a: dependent('A', 'b'), b: dependent('B', 'c'), c: { type: 'select', options: [{ label: 'A', value: 'a' }] } }))).not.toThrow();
  });

  it("refuses a declared default that is not offered while the other values are at their defaults", () => {
    refuses({ standard: STANDARD, size: sized({ default: 'n4' }) },
      `param 'size': the default "n4" is not offered while the other values are at their defaults — an untouched dialog would show one thing and the builder get another`);
    expect(resolved({ standard: { ...STANDARD, default: 'unc' }, size: sized({ default: 'n4' }) }).params.size).toMatchObject({ default: 'n4' });
    expect(resolved({ standard: STANDARD, size: sized({ default: 'custom' }) }).params.size).toMatchObject({ default: 'custom' });
  });

  it("takes the first option offered there for a default left out — whatever the order the values are declared in", () => {
    expect(FeatureMetas.defaultOf(resolved({ standard: { ...STANDARD, default: 'unc' }, size: sized() }).params.size)).toBe('n4');
    expect(FeatureMetas.defaultOf(resolved({ size: sized(), standard: { ...STANDARD, default: 'unc' } }).params.size)).toBe('n4');
    expect(FeatureMetas.defaultOf(resolved({ standard: STANDARD, size: sized() }).params.size)).toBe('m3');
    // A chain: `thread` waits on `size`, which waits on `standard`.
    const thread = { type: 'radio', options: [{ label: 'Coarse', value: 'coarse', when: { size: 'm3' } }, { label: 'UNC', value: 'unc', when: { size: 'n4' } }] };
    const chain = resolved({ thread, size: sized(), standard: { ...STANDARD, default: 'unc' } });
    expect(FeatureMetas.defaultOf(chain.params.thread)).toBe('unc');
    expect(parseCall(chain, [undefined, {}])).toMatchObject({ standard: 'unc', size: 'n4', thread: 'unc' });
    expect((snapshotFeatureMeta(chain).params.thread as { default: unknown }).default).toBe('unc');
  });

  it("refuses a value with no option offered there, unless it is optional — a clause on a value with nothing at rest does not hold", () => {
    const only = (patch: Record<string, unknown> = {}) => ({ type: 'select', options: [{ label: '#4', value: 'n4', when: { standard: 'unc' } }], ...patch });
    refuses({ standard: STANDARD, size: only() },
      `param 'size': none of its options is offered while the other values are at their defaults — leave the 'when' off one, or make the value 'optional'`);
    const optional = resolved({ standard: STANDARD, size: only({ optional: true }) });
    expect(FeatureMetas.defaultOf(optional.params.size)).toBeUndefined();
    expect(parseCall(optional, [undefined, {}]).size).toBeUndefined();
    const onCount = { type: 'select', options: [{ label: 'Two', value: 'two', when: { count: 2 } }] };
    refuses({ count: { type: 'integer' }, size: onCount }, `param 'size': none of its options is offered while the other values are at their defaults`);
    expect(FeatureMetas.defaultOf(resolved({ count: { type: 'integer', default: 2 }, size: onCount }).params.size)).toBe('two');
  });

  it("holds a multi-select's default to the same rule, element by element", () => {
    refuses({ standard: STANDARD, size: sized({ multiple: true, default: ['m3', 'n4'] }) },
      `param 'size': the default's "n4" is not offered while the other values are at their defaults — an untouched dialog would show one thing and the builder get another`);
    expect(FeatureMetas.defaultOf(resolved({ standard: STANDARD, size: sized({ multiple: true, default: ['m3', 'custom'] }) }).params.size)).toEqual(['m3', 'custom']);
    expect(FeatureMetas.defaultOf(resolved({ standard: STANDARD, size: sized({ multiple: true }) }).params.size)).toEqual([]);
  });

  it("narrows the dialog only: a call may pass any declared option, whatever the other values are", () => {
    const lenient = resolved({ standard: STANDARD, size: sized() });
    expect(parseCall(lenient, [undefined, { size: 'n4' }])).toMatchObject({ standard: 'iso', size: 'n4' });
    expect(parseCall(lenient, [undefined, { standard: 'unc', size: 'm3' }])).toMatchObject({ standard: 'unc', size: 'm3' });
    expect(() => parseCall(lenient, [undefined, { size: 'm9' }])).toThrow();
  });

  it("carries 'when' into the snapshot verbatim", () => {
    const { size } = snapshotFeatureMeta(resolved({ standard: STANDARD, size: sized() })).params as Record<string, Record<string, any>>;
    expect(size.options).toEqual([{ label: 'M3', value: 'm3', when: { standard: 'iso' } }, { label: '#4', value: 'n4', when: { standard: 'unc' } }, { label: 'Custom', value: 'custom' }]);
    expect(size.default).toBe('m3');
  });
});

describe("choice values: select and radio", () => {
  const AB = [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }];
  const at = "feature 'acme.boss': param 'height'";
  const refuses = (spec: Record<string, unknown>, message: string) =>
    expect(() => register(withParam('height', spec))).toThrow(message);
  const option = (patch: Record<string, unknown>) => ({ type: 'select', options: [{ label: 'A', value: 'a', ...patch }] });

  it("refuses a radio's options and default as it does a select's", () => {
    refuses({ type: 'radio' }, `${at}: a radio needs 'options', a list of { label, value }`);
    refuses({ type: 'radio', options: [{ label: 'A', value: true }] }, `${at}: each option is { label, value } with a string or number value, got {"label":"A","value":true}`);
    refuses({ type: 'radio', options: [...AB, { label: 'C', value: 'a' }] }, `${at}: 'options' lists "a" twice`);
    refuses({ type: 'radio', options: AB, default: 'c' }, `${at}: the default "c" is not one of its options' values`);
  });

  it("refuses an option field it doesn't know, by name", () => {
    refuses(option({ icon: './a.svg' }), `${at}: option "a": unknown field 'icon' — an option's fields are label, value, image, description, group, keywords, when`);
  });

  it("refuses an option's image that is not an image inside the module's directory", () => {
    refuses(option({ image: '../a.svg' }), `${at}: option "a": 'image' must be a relative path inside the module's directory, such as './image.svg', got '../a.svg'`);
    refuses(option({ image: 'https://example.com/a.svg' }), `${at}: option "a": 'image' must be a relative path inside the module's directory`);
    refuses(option({ image: './a.js' }), `${at}: option "a": 'image' must be an image (.svg, .png, .jpg or .webp), got './a.js'`);
    refuses(option({ image: 3 }), `${at}: option "a": 'image' must be a non-empty string, got 3`);
  });

  it("refuses an option's description, group and keywords of the wrong shape", () => {
    refuses(option({ description: 3 }), `${at}: option "a": 'description' must be a string, got 3`);
    refuses(option({ group: '' }), `${at}: option "a": 'group' must be a non-empty string, got ''`);
    refuses(option({ keywords: [] }), `${at}: option "a": 'keywords' must be a non-empty list of words — leave it out when the option has none, got a list`);
    refuses(option({ keywords: 'iso' }), `${at}: option "a": 'keywords' must be a non-empty list of words`);
    refuses(option({ keywords: ['iso', 3] }), `${at}: option "a": each of 'keywords' must be a non-empty string, got 3`);
  });

  it("refuses a display the type doesn't have, columns without the display that has them, and a search on a radio", () => {
    refuses({ type: 'select', options: AB, display: 'cards' }, `${at}: 'display' must be one of list, grid, got 'cards'`);
    refuses({ type: 'radio', options: AB, display: 'grid' }, `${at}: 'display' must be one of list, inline, buttons, cards, got 'grid'`);
    refuses({ type: 'select', options: AB, columns: 3 }, `${at}: 'columns' is for display: 'grid' — leave it out`);
    refuses({ type: 'select', options: AB, display: 'list', columns: 3 }, `${at}: 'columns' is for display: 'grid' — leave it out`);
    refuses({ type: 'radio', options: AB, display: 'buttons', columns: 3 }, `${at}: 'columns' is for display: 'cards' — leave it out`);
    for (const columns of [1, 7, 2.5, '3']) {
      refuses({ type: 'select', options: AB, display: 'grid', columns }, `${at}: 'columns' must be a whole number from 2 to 6, got ${typeof columns === 'string' ? "'3'" : columns}`);
    }
    refuses({ type: 'select', options: AB, search: 'yes' }, `${at}: 'search' must be true or false, got 'yes'`);
    refuses({ type: 'radio', options: AB, search: true }, `${at}: unknown field 'search' for a radio value — its fields are label, description, group, tab, hint, aside, visibleWhen, optional, default, options, display, columns`);
    refuses({ type: 'length', display: 'grid' }, `${at}: 'display' must be one of slider — leave it out for the plain input — got 'grid'`);
  });

  it("takes every display, with columns from 2 to 6 where the display has them", () => {
    for (const display of ['list', 'grid']) {
      expect(() => register(withParam('height', { type: 'select', options: AB, display, search: true }))).not.toThrow();
    }
    for (const display of ['list', 'inline', 'buttons', 'cards']) {
      expect(() => register(withParam('height', { type: 'radio', options: AB, display }))).not.toThrow();
    }
    for (const columns of [2, 6]) {
      expect(() => register(withParam('height', { type: 'select', options: AB, display: 'grid', columns }))).not.toThrow();
      expect(() => register(withParam('height', { type: 'radio', options: AB, display: 'cards', columns }))).not.toThrow();
    }
  });

  it("resolves a radio as a select: its default, else its first option — an optional one stays unset", () => {
    const params = {
      declared: { type: 'radio', options: AB, default: 'b' },
      first: { type: 'radio', options: AB },
      unset: { type: 'radio', options: AB, optional: true },
    };
    const meta = getFeatureMeta(register(bossMeta({ params, call: [{ declared: 'declared', first: 'first', unset: 'unset' }] })))!;
    expect(meta.params.first).toEqual({ type: 'radio', options: AB, default: 'a' });
    expect('default' in meta.params.unset).toBe(false);
    expect(parseCall(meta, [])).toEqual({ declared: 'b', first: 'a', unset: undefined });
    expect(parseCall(meta, [{ first: 'b', unset: 'a' }])).toEqual({ declared: 'b', first: 'b', unset: 'a' });
    expect(() => parseCall(meta, [{ first: 'c' }])).toThrow(`boss(): 'first' must be one of "a", "b", got 'c'`);
    expect(snapshotFeatureMeta(meta).params.first).toEqual({ type: 'radio', options: AB, default: 'a', label: 'First' });
  });

  it("leaves a plain select's snapshot as it was", () => {
    const meta = getFeatureMeta(register(withParam('height', { type: 'select', options: AB })))!;
    expect(snapshotFeatureMeta(meta).params.height).toEqual({ type: 'select', options: AB, default: 'a', label: 'Height' });
    expect(JSON.stringify(snapshotFeatureMeta(meta).params.height)).toBe('{"type":"select","options":[{"label":"A","value":"a"},{"label":"B","value":"b"}],"default":"a","label":"Height"}');
  });

  it("carries the fastener's displays, images, groups and keywords into the snapshot verbatim", () => {
    const { meta } = defineFastener();
    const { size, head } = snapshotFeatureMeta(meta).params as Record<string, Record<string, any>>;
    expect(size).toMatchObject({ type: 'select', label: 'Screw', default: 'm3', display: 'grid', columns: 3 });
    expect(size.options[0]).toEqual({ label: 'M3', value: 'm3', image: './fastener/m3.svg', description: '3.4 mm clearance', when: { standard: 'iso' }, keywords: ['iso'] });
    expect(size.options.map((o: { when: unknown }) => o.when)).toEqual([{ standard: 'iso' }, { standard: 'iso' }, { standard: 'iso' }, { standard: 'unc' }, { standard: 'unc' }]);
    expect(head).toMatchObject({ type: 'radio', label: 'Head', default: 'plain', display: 'cards', columns: 3 });
    expect(head.options.map((o: { value: string; image: string }) => [o.value, o.image])).toEqual([
      ['plain', './fastener/plain.svg'], ['counterbore', './fastener/counterbore.svg'], ['countersink', './fastener/countersink.svg'],
    ]);
    expect(JSON.parse(JSON.stringify(snapshotFeatureMeta(meta)))).toEqual(snapshotFeatureMeta(meta));
  });

  it("lists every declared asset once, in order: the icon, the options' images, then the layout's and the aside's", () => {
    const { meta } = defineFastener();
    const assets = [
      './fastener.svg',
      './fastener/m3.svg', './fastener/m4.svg', './fastener/m5.svg', './fastener/n4.svg', './fastener/n6.svg',
      './fastener/plain.svg', './fastener/counterbore.svg', './fastener/countersink.svg',
      './fastener/depth.svg', './fastener/section.svg',
    ];
    expect(FeatureMetas.assetsOf(meta)).toEqual(assets);
    expect(FeatureMetas.assetsOf(snapshotFeatureMeta(meta))).toEqual(assets);
    // The engine's root entry lists them too: what the editor's catalog serves from.
    expect(listFeatureAssets(snapshotFeatureMeta(meta))).toEqual(assets);

    // A file two options share, or an option shares with the icon, is listed once; no icon, no images, nothing.
    const shared = [{ label: 'A', value: 'a', image: './boss.svg' }, { label: 'B', value: 'b', image: './b.png' }, { label: 'C', value: 'c', image: './b.png' }, { label: 'D', value: 'd' }];
    const twice = getFeatureMeta(register({ ...withParam('height', { type: 'radio', options: shared }), icon: './boss.svg' }))!;
    expect(FeatureMetas.assetsOf(twice)).toEqual(['./boss.svg', './b.png']);
    expect(FeatureMetas.assetsOf(getFeatureMeta(register(withParam('height', { type: 'select', options: AB })))!)).toEqual([]);
  });
});

describe("a select with multiple: true — a list of option values", () => {
  setupOC();

  const ABC = [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }, { label: 'C', value: 3 }];
  const at = "feature 'acme.boss': param 'height'";
  const multi = (patch: Record<string, unknown> = {}) => ({ type: 'select', multiple: true, options: ABC, ...patch });
  const refuses = (spec: Record<string, unknown>, message: string) =>
    expect(() => register(withParam('height', spec))).toThrow(message);
  const snapshot = (spec: Record<string, unknown>) =>
    snapshotFeatureMeta(withParam('height', spec) as FeatureMeta).params.height as Record<string, unknown>;
  const call = (spec: Record<string, unknown>, ...args: unknown[]) =>
    parseCall(getFeatureMeta(register(withParam('height', spec)))!, [select(face().planar()), ...args]).height;

  it("refuses 'multiple' and its counts where they don't belong, by name", () => {
    refuses({ type: 'radio', multiple: true, options: ABC }, `${at}: 'multiple' is for a select — a radio holds one value`);
    refuses({ type: 'select', options: ABC, min: 1 }, `${at}: 'min' counts the values of a select with 'multiple: true' — add it or leave 'min' out`);
    refuses({ type: 'select', multiple: false, options: ABC, max: 2 }, `${at}: 'max' counts the values of a select with 'multiple: true' — add it or leave 'max' out`);
    refuses(multi({ min: -1 }), `${at}: 'min' must be a whole number, 0 or more, got -1`);
    refuses(multi({ max: 0 }), `${at}: 'max' must be a whole number, 1 or more, got 0`);
    refuses(multi({ max: 1.5 }), `${at}: 'max' must be a whole number, 1 or more, got 1.5`);
    refuses(multi({ min: 2, max: 1, default: ['a', 'b'] }), `${at}: 'min' (2) is above 'max' (1)`);
    refuses(multi({ max: 4 }), `${at}: 'max' (4) is more than its 3 options`);
    refuses(multi({ min: 4, default: ['a'] }), `${at}: 'min' (4) is more than its 3 options`);
  });

  it("refuses a default that is not a list its own options and counts accept", () => {
    refuses(multi({ default: 'a' }), `${at}: the default must be a list of its options' values, got 'a'`);
    refuses(multi({ default: ['a', 'z'] }), `${at}: the default's "z" is not one of its options' values`);
    refuses(multi({ default: ['a', 'a'] }), `${at}: the default lists "a" twice`);
    refuses(multi({ min: 2, default: ['a'] }), `${at}: the default holds 1, under its 'min' (2)`);
    refuses(multi({ max: 1, default: ['a', 'b'] }), `${at}: the default holds 2, over its 'max' (1)`);
    // An untouched dialog would show an empty list the builder then refuses.
    refuses(multi({ min: 1 }), `${at}: with 'min: 1' it needs a 'default' — left out, the list starts empty, which its own 'min' refuses`);
    expect(() => register(withParam('height', multi({ min: 1, max: 2, default: ['b', 3], display: 'grid', columns: 3, search: true })))).not.toThrow();
  });

  it("refuses one as the rest value, and as what a visibleWhen names", () => {
    expect(() => register(withParam('height', multi(), ['face', '...height'])))
      .toThrow("the rest value '...height' must be a list — a picker with 'multiple: true'");
    expect(() => register({
      ...withParam('height', multi(), ['face', { height: 'height', depth: 'depth' }]),
      params: { face: { picker: 'face' }, height: multi(), depth: { type: 'length', optional: true, visibleWhen: { height: 'a' } } },
    })).toThrow("param 'depth': 'visibleWhen' names 'height', a select with 'multiple: true' — it can only name a value that holds one thing");
  });

  it("resolves the default to the declared list, or the empty one, in the snapshot", () => {
    expect(snapshot(multi())).toEqual({ type: 'select', multiple: true, options: ABC, default: [], label: 'Height' });
    expect(snapshot(multi({ optional: true })).default).toEqual([]);
    expect(snapshot(multi({ default: ['b', 'a'], max: 2 }))).toMatchObject({ default: ['b', 'a'], max: 2 });
  });

  it("gives the builder a list always: the call's, in the order written, or the default", () => {
    expect(call(multi(), { height: ['b', 'a'] })).toEqual(['b', 'a']);
    expect(call(multi(), { height: [] })).toEqual([]);
    expect(call(multi())).toEqual([]);
    expect(call(multi({ optional: true }))).toEqual([]);
    expect(call(multi({ default: [3, 'a'] }))).toEqual([3, 'a']);
    expect(call(multi({ default: [3, 'a'] }), { height: ['b'] })).toEqual(['b']);
  });

  it("refuses a call's value that is not a list of distinct options within the counts", () => {
    const options = '"a", "b", 3';
    expect(() => call(multi(), { height: 'a' })).toThrow(`boss(): 'height' must be a list of ${options}, got 'a'`);
    expect(() => call(multi(), { height: ['a', 'z'] })).toThrow(`boss(): each of 'height' must be one of ${options}, got 'z'`);
    expect(() => call(multi(), { height: ['a', 'b', 'a'] })).toThrow(`boss(): 'height' lists "a" twice`);
    expect(() => call(multi({ max: 2 }), { height: ['a', 'b', 3] })).toThrow(`boss(): 'height' takes at most 2, got 3`);
    expect(() => call(multi({ min: 2, default: ['a', 'b'] }), { height: ['a'] })).toThrow(`boss(): 'height' takes at least 2, got 1`);
  });

  it("compares two lists element by element: the same list is equal, another order is not", () => {
    const Tags = class extends Feature<{ tags: string[] }> {
      static id = 'acme.tags';
    };
    expect(new Tags({ tags: ['a', 'b'] }).compareTo(new Tags({ tags: ['a', 'b'] }))).toBe(true);
    expect(new Tags({ tags: ['a', 'b'] }).compareTo(new Tags({ tags: ['b', 'a'] }))).toBe(false);
    expect(new Tags({ tags: [] }).compareTo(new Tags({ tags: ['a'] }))).toBe(false);
  });
});

describe("how a typed-in value's row looks: slider, stepper, suffix, checkbox, text limits, hint", () => {
  const at = "feature 'acme.boss': param 'height'";
  const refuses = (spec: Record<string, unknown>, message: string) =>
    expect(() => register(withParam('height', spec))).toThrow(message);
  const snapshot = (spec: Record<string, unknown>) =>
    snapshotFeatureMeta(getFeatureMeta(register(withParam('height', spec)))!).params.height as Record<string, unknown>;

  it("refuses a slider without both ends, a stepper on a length or an angle, and a display there isn't", () => {
    for (const type of ['number', 'integer', 'length', 'angle']) {
      refuses({ type, display: 'slider' }, `${at}: display: 'slider' needs both 'min' and 'max' — the track runs from one to the other`);
      refuses({ type, display: 'slider', min: 0 }, `${at}: display: 'slider' needs both 'min' and 'max'`);
      refuses({ type, display: 'slider', max: 5 }, `${at}: display: 'slider' needs both 'min' and 'max'`);
      expect(() => register(withParam('height', { type, display: 'slider', min: 0, max: 5 }))).not.toThrow();
    }
    refuses({ type: 'length', display: 'stepper' }, `${at}: display: 'stepper' is for a number or an integer — a length takes 'slider', or leave it out`);
    refuses({ type: 'angle', display: 'stepper' }, `${at}: display: 'stepper' is for a number or an integer — an angle takes 'slider', or leave it out`);
    refuses({ type: 'number', display: 'input' }, `${at}: 'display' must be one of slider, stepper — leave it out for the plain input — got 'input'`);
    refuses({ type: 'integer', display: 'slider', min: 0.5, max: 4 }, `${at}: the min of an integer slider must be a whole number, got 0.5`);
    expect(() => register(withParam('height', { type: 'integer', display: 'stepper' }))).not.toThrow();
    expect(() => register(withParam('height', { type: 'number', display: 'stepper', min: 0, step: 0.5 }))).not.toThrow();
  });

  it("refuses a suffix that is empty, long or not a string, a boolean display but 'checkbox', and an empty hint", () => {
    refuses({ type: 'length', suffix: '' }, `${at}: 'suffix' must be a non-empty string of at most 8 characters, got ''`);
    refuses({ type: 'length', suffix: 'millimetres' }, `${at}: 'suffix' must be a non-empty string of at most 8 characters, got 'millimetres'`);
    refuses({ type: 'length', suffix: 3 }, `${at}: 'suffix' must be a non-empty string of at most 8 characters, got 3`);
    refuses({ type: 'text', suffix: 'mm' }, `${at}: unknown field 'suffix' for a text value`);
    refuses({ type: 'boolean', display: 'toggle' }, `${at}: 'display' must be 'checkbox' — leave it out for the toggle — got 'toggle'`);
    refuses({ type: 'length', hint: '' }, `${at}: 'hint' must be a non-empty string, got ''`);
    expect(() => register(bossMeta({ params: { face: { picker: 'face', hint: 7 } }, call: ['face'] }))).toThrow("param 'face': 'hint' must be a non-empty string, got 7");
    expect(() => register(bossMeta({ params: { face: { picker: 'face', hint: 'The face it stands on' } }, call: ['face'] }))).not.toThrow();
  });

  it("refuses a text's limits that don't hold, and a default that breaks them", () => {
    refuses({ type: 'text', multiline: 'yes' }, `${at}: 'multiline' must be true or false, got 'yes'`);
    refuses({ type: 'text', placeholder: '' }, `${at}: 'placeholder' must be a non-empty string, got ''`);
    for (const maxLength of [0, 2.5, '12']) {
      refuses({ type: 'text', maxLength }, `${at}: 'maxLength' must be a whole number of 1 or more, got ${typeof maxLength === 'string' ? "'12'" : maxLength}`);
    }
    refuses({ type: 'text', pattern: 7 }, `${at}: 'pattern' must be a regular expression as a non-empty string, got 7`);
    refuses({ type: 'text', pattern: '[A-Z' }, `${at}: 'pattern' is not a regular expression: `);
    refuses({ type: 'text', maxLength: 3, default: 'abcd' }, `${at}: the default must be at most 3 characters, got 4`);
    refuses({ type: 'text', pattern: '[A-Z]+', default: 'A1' }, `${at}: the default must match [A-Z]+, got "A1"`);
    // The whole value is matched: a part of it matching is not enough.
    refuses({ type: 'text', pattern: 'A', default: 'AA' }, `${at}: the default must match A, got "AA"`);
    refuses({ type: 'length', maxLength: 3 }, `${at}: unknown field 'maxLength' for a length value`);
    expect(() => register(withParam('height', { type: 'text', multiline: true, placeholder: 'A note', maxLength: 4, pattern: '[A-Z]+', default: 'ABCD' }))).not.toThrow();
  });

  it("resolves a slider without a default to its min, in the snapshot and in a call that leaves it out", () => {
    expect(snapshot({ type: 'length', display: 'slider', min: 2, max: 9 })).toEqual({ type: 'length', display: 'slider', min: 2, max: 9, default: 2, label: 'Height' });
    expect(snapshot({ type: 'length', display: 'slider', min: 2, max: 9, default: 4 }).default).toBe(4);
    expect(snapshot({ type: 'length', display: 'slider', min: 2, max: 9, optional: true }).default).toBe(2);
    expect(snapshot({ type: 'integer', display: 'stepper', min: 2 })).not.toHaveProperty('default');
    const meta = getFeatureMeta(register(bossMeta({ params: { height: { type: 'length', display: 'slider', min: 2, max: 9 } }, call: [{ height: 'height' }] })))!;
    expect(parseCall(meta, [])).toEqual({ height: 2 });
    expect(parseCall(meta, [{ height: 5 }])).toEqual({ height: 5 });
    expect(() => parseCall(meta, [{ height: 10 }])).toThrow("boss(): 'height' must be at most 9, got 10");
  });

  it("holds a call's text to maxLength and pattern", () => {
    const meta = getFeatureMeta(register(bossMeta({ params: { height: { type: 'text', maxLength: 4, pattern: '[A-Z-]*' } }, call: [{ height: 'height' }] })))!;
    expect(parseCall(meta, [{ height: 'A-B' }])).toEqual({ height: 'A-B' });
    expect(parseCall(meta, [{ height: '' }])).toEqual({ height: '' });
    expect(() => parseCall(meta, [{ height: 'ABCDE' }])).toThrow("boss(): 'height' must be at most 4 characters, got 5");
    expect(() => parseCall(meta, [{ height: 'a1' }])).toThrow(`boss(): 'height' must match [A-Z-]*, got "a1"`);
  });

  it("carries every new field into the snapshot verbatim, and leaves a spec without them as it was", () => {
    expect(snapshot({ type: 'integer', display: 'stepper', min: 1, max: 8, step: 2, suffix: 'x', hint: 'How many' }))
      .toEqual({ type: 'integer', display: 'stepper', min: 1, max: 8, step: 2, suffix: 'x', hint: 'How many', label: 'Height' });
    expect(snapshot({ type: 'boolean', display: 'checkbox' })).toEqual({ type: 'boolean', display: 'checkbox', default: false, label: 'Height' });
    expect(snapshot({ type: 'text', multiline: true, placeholder: 'A note', maxLength: 40, pattern: '[^!]*' }))
      .toEqual({ type: 'text', multiline: true, placeholder: 'A note', maxLength: 40, pattern: '[^!]*', label: 'Height' });
    expect(JSON.stringify(snapshot({ type: 'length', min: 0 }))).toBe('{"type":"length","min":0,"label":"Height"}');
    const { depth, marking } = snapshotFeatureMeta(defineFastener().meta).params as Record<string, unknown>;
    expect(depth).toEqual({ type: 'length', default: 10, min: 1, max: 50, display: 'slider', suffix: 'mm', hint: 'Measured from the surface', label: 'Depth' });
    expect(marking).toEqual({ type: 'text', optional: true, placeholder: 'A2-70', maxLength: 12, pattern: '[A-Za-z0-9-]*', hint: 'Letters, digits and dashes', label: 'Marking' });
  });
});
