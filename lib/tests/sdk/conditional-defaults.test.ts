// Conditional defaults: a typed-in value's `defaults: [{ when, value }]`,
// the first entry whose `when` holds winning over its plain `default`. The
// schema refuses a bad declaration by name; a call, an insert and a
// generator that leave the value out get its effective default, worked out
// from their other values; the snapshot carries `defaults` verbatim.

import { describe, it, expect } from "vitest";
import { getFeatureMeta, registerBuilder, snapshotFeatureMeta } from "../../index.js";
import { Feature, Generator, defineAssembly, definePart, parseCall, type FeatureMeta } from "../../sdk/index.js";
import { FeatureMetas } from "../../sdk/meta.js";
import { ValueSchema } from "../../sdk/value-schema.js";
import { ValueConditions } from "../../sdk/value-conditions.js";
import { GeneratedSchemas } from "../../sdk/generated-schema.js";
import type { Shape } from "../../sdk/kernel.js";

const TYPE = {
  type: 'radio',
  options: [{ label: 'Base', value: 'base' }, { label: 'Wall', value: 'wall' }, { label: 'Wardrobe', value: 'wardrobe' }],
};

const HEIGHT = {
  type: 'length', default: 900, min: 300, max: 3000,
  defaults: [
    { when: { type: 'wall' }, value: 720 },
    { when: { type: 'wardrobe' }, value: 2400 },
  ],
};

/** The cabinet's values: a type, and a height whose default follows it. */
const CABINET = { type: TYPE, height: HEIGHT, depth: { type: 'length', default: 560, min: 100 } };

function toolClass() {
  return class extends Feature {
    static id = 'acme.cabinet';
    buildTool(): Shape[] {
      return [];
    }
  };
}

function cabinetMeta(params: Record<string, unknown> = CABINET): FeatureMeta {
  return {
    class: toolClass(),
    label: 'Cabinet',
    group: 'create',
    kind: 'tool',
    params,
    call: [Object.fromEntries(Object.keys(params).map(name => [name, name]))],
  } as unknown as FeatureMeta;
}

const register = (meta: FeatureMeta) => registerBuilder(() => () => undefined, { feature: meta });
const resolved = (params: Record<string, unknown> = CABINET) => getFeatureMeta(register(cabinetMeta(params)))!;
const refuses = (params: Record<string, unknown>, message: string) =>
  expect(() => register(cabinetMeta(params))).toThrow(`feature 'acme.cabinet': ${message}`);

describe("conditional defaults: declaring them", () => {
  it("takes a list of { when, value } on every typed-in type", () => {
    expect(() => resolved()).not.toThrow();
    const flags = { type: TYPE, hang: { type: 'boolean', defaults: [{ when: { type: 'wall' }, value: true }] } };
    expect(() => resolved(flags)).not.toThrow();
    const text = { type: TYPE, note: { type: 'text', default: 'floor', defaults: [{ when: { type: ['wall', 'wardrobe'] }, value: 'wall' }] } };
    expect(() => resolved(text)).not.toThrow();
    const list = {
      type: TYPE,
      parts: { type: 'select', multiple: true, options: [{ label: 'Top', value: 'top' }, { label: 'Base', value: 'base' }], default: ['top', 'base'],
        defaults: [{ when: { type: 'wall' }, value: ['top'] }] },
    };
    expect(() => resolved(list)).not.toThrow();
  });

  it("refuses a malformed list or entry by its place", () => {
    const at = `param 'height'`;
    refuses({ type: TYPE, height: { ...HEIGHT, defaults: [] } },
      `${at}: 'defaults' must be a non-empty list of { when, value }, such as [{ when: { type: 'wall' }, value: 720 }], got a list`);
    refuses({ type: TYPE, height: { ...HEIGHT, defaults: { when: { type: 'wall' }, value: 720 } } }, `${at}: 'defaults' must be a non-empty list of { when, value }`);
    refuses({ type: TYPE, height: { ...HEIGHT, defaults: [720] } }, `${at}: defaults[0] must be { when, value }, such as { when: { type: 'wall' }, value: 720 }, got 720`);
    refuses({ type: TYPE, height: { ...HEIGHT, defaults: [{ when: { type: 'wall' }, value: 720, label: 'x' }] } },
      `${at}: defaults[0]: unknown field 'label' — an entry of 'defaults' is { when, value }`);
    refuses({ type: TYPE, height: { ...HEIGHT, defaults: [{ value: 720 }] } }, `${at}: defaults[0] needs a 'when': the values it waits on, such as { type: 'wall' }`);
    refuses({ type: TYPE, height: { ...HEIGHT, defaults: [{ when: { type: 'wall' } }] } }, `${at}: defaults[0] needs a 'value': the default while its 'when' holds`);
  });

  it("checks each value as the call's value is checked: type, range, a whole number, an option", () => {
    const at = `param 'height': defaults[1]`;
    refuses({ type: TYPE, height: { ...HEIGHT, defaults: [HEIGHT.defaults[0], { when: { type: 'wardrobe' }, value: 3600 }] } },
      `${at}: 'height' must be at most 3000, got 3600`);
    refuses({ type: TYPE, height: { ...HEIGHT, defaults: [HEIGHT.defaults[0], { when: { type: 'wardrobe' }, value: 'tall' }] } },
      `${at}: 'height' must be a number, got 'tall'`);
    refuses({ type: TYPE, shelves: { type: 'integer', default: 2, defaults: [{ when: { type: 'wall' }, value: 1.5 }] } },
      `param 'shelves': defaults[0]: 'shelves' must be a whole number, got 1.5`);
    refuses({ type: TYPE, finish: { type: 'select', options: [{ label: 'Oak', value: 'oak' }], defaults: [{ when: { type: 'wall' }, value: 'pine' }] } },
      `param 'finish': defaults[0]: 'finish' must be one of "oak", got 'pine'`);
    refuses({ type: TYPE, note: { type: 'text', default: 'a', maxLength: 3, defaults: [{ when: { type: 'wall' }, value: 'toolong' }] } },
      `param 'note': defaults[0]: 'note' must be at most 3 characters, got 7`);
  });

  it("refuses a 'when' that names an unknown value, a picked one, itself, or a value it cannot take", () => {
    const at = `param 'height': defaults[0]: 'when'`;
    const height = (when: unknown) => ({ ...HEIGHT, defaults: [{ when, value: 720 }] });
    refuses({ type: TYPE, height: height({ kind: 'wall' }) }, `${at} names 'kind', which is not one of the feature's values`);
    refuses({ type: TYPE, at: { picker: 'face', optional: true }, height: height({ at: 'wall' }) }, `${at} names 'at', a picked value — it can only name a typed-in one`);
    refuses({ type: TYPE, height: height({ height: 900 }) }, `${at} names the value itself`);
    refuses({ type: TYPE, height: height({ type: 'shed' }) }, `${at}: "shed" is not a value 'type' can take`);
    refuses({ type: TYPE, height: height([]) }, `${at}: the list is empty`);
  });

  it("refuses a 'when' naming a value that declares 'defaults' itself — one level, no chains, no circles", () => {
    const depth = { type: 'length', default: 560, defaults: [{ when: { type: 'wall' }, value: 320 }] };
    refuses({ type: TYPE, depth, height: { ...HEIGHT, defaults: [{ when: { depth: 320 }, value: 720 }] } },
      `param 'height': defaults[0]: 'when' names 'depth', which declares 'defaults' itself — a conditional default waits only on values whose default is fixed (one level, no chains)`);
    refuses({
      a: { type: 'length', default: 1, defaults: [{ when: { b: 2 }, value: 3 }] },
      b: { type: 'length', default: 2, defaults: [{ when: { a: 1 }, value: 3 }] },
    }, `param 'a': defaults[0]: 'when' names 'b', which declares 'defaults' itself`);
  });

  it("refuses a value whose options and defaults wait on each other, naming the circle", () => {
    const size = { type: 'select', optional: true, options: [{ label: 'S', value: 's', when: { height: 720 } }] };
    refuses({ type: TYPE, size, height: { ...HEIGHT, defaults: [{ when: { size: 's' }, value: 720 }] } },
      `param 'size': the 'when' of its options and of its 'defaults' comes back round to it (size → height → size) — values that wait on each other have no first one to settle`);
  });

  it("needs a plain default to fall back on, and refuses 'defaults' on a picker", () => {
    refuses({ type: TYPE, height: { type: 'length', defaults: [{ when: { type: 'wall' }, value: 720 }] } },
      `param 'height': a value with 'defaults' needs a 'default' — the one it takes when none of them holds`);
    refuses({ type: TYPE, at: { picker: 'face', defaults: [] } }, `param 'at': a picker takes no defaults — its value is what the user picks`);
    // A select, a radio and a boolean fall back on what their control always shows.
    expect(() => resolved({ type: TYPE, hang: { type: 'boolean', defaults: [{ when: { type: 'wall' }, value: true }] } })).not.toThrow();
  });

  it("refuses a conditional default the select does not offer where it applies", () => {
    const door = {
      type: 'select',
      options: [
        { label: 'Drawer', value: 'drawer', when: { type: ['base', 'wardrobe'] } },
        { label: 'Flap', value: 'flap', when: { type: 'wall' } },
        { label: 'Door', value: 'door' },
      ],
      default: 'drawer',
    };
    expect(() => resolved({ type: TYPE, front: { ...door, defaults: [{ when: { type: 'wall' }, value: 'flap' }] } })).not.toThrow();
    refuses({ type: TYPE, front: { ...door, defaults: [{ when: { type: 'wall' }, value: 'drawer' }] } },
      `param 'front': defaults[0]: "drawer" is not offered while type is "wall" and the other values are at their defaults — an untouched dialog would show one thing and the builder get another`);
    // Each value a case lists is taken in turn.
    refuses({ type: TYPE, front: { ...door, defaults: [{ when: { type: ['wall', 'wardrobe'] }, value: 'flap' }] } },
      `param 'front': defaults[0]: "flap" is not offered while type is "wardrobe"`);
    // A plain default shown nowhere at rest is fine when a conditional one holds there.
    const atRest = { type: { ...TYPE, default: 'wall' }, front: { ...door, default: 'drawer', defaults: [{ when: { type: 'wall' }, value: 'flap' }] } };
    expect(() => resolved(atRest)).not.toThrow();
  });

  it("works the other values out in each case: a value whose defaults follow the case decides what is offered", () => {
    const shelf = {
      type: 'select',
      options: [{ label: 'Low', value: 'low', when: { height: [720, 900] } }, { label: 'High', value: 'high', when: { height: 2400 } }],
      default: 'low',
      defaults: [{ when: { type: 'wardrobe' }, value: 'high' }],
    };
    expect(() => resolved({ type: TYPE, height: HEIGHT, shelf })).not.toThrow();
    refuses({ type: TYPE, height: HEIGHT, shelf: { ...shelf, defaults: [{ when: { type: 'wardrobe' }, value: 'low' }] } },
      `param 'shelf': defaults[0]: "low" is not offered while type is "wardrobe"`);
  });
});

describe("conditional defaults: resolution", () => {
  it("gives a call that leaves the value out its effective default, from the call's other values", () => {
    const meta = resolved();
    expect(parseCall(meta, [{}])).toMatchObject({ type: 'base', height: 900 });
    expect(parseCall(meta, [{ type: 'wall' }])).toMatchObject({ type: 'wall', height: 720 });
    expect(parseCall(meta, [{ type: 'wardrobe' }])).toMatchObject({ type: 'wardrobe', height: 2400 });
    expect(parseCall(meta, [{ type: 'wall', height: 800 }])).toMatchObject({ type: 'wall', height: 800 });
    expect(parseCall(meta, [{ type: 'wall', height: null }])).toMatchObject({ type: 'wall', height: 720 });
  });

  it("reads the named values after their own defaults resolve", () => {
    const meta = resolved({ type: { ...TYPE, default: 'wardrobe' }, height: HEIGHT });
    expect(parseCall(meta, [{}])).toMatchObject({ type: 'wardrobe', height: 2400 });
  });

  it("takes the first entry that holds, and lists of cases, any one holding", () => {
    const height = { ...HEIGHT, defaults: [{ when: [{ type: 'wall' }, { type: 'wardrobe', tall: false }], value: 720 }, { when: { type: 'wardrobe' }, value: 2400 }] };
    const meta = resolved({ type: TYPE, tall: { type: 'boolean', default: false }, height });
    expect(parseCall(meta, [{ type: 'wardrobe' }])).toMatchObject({ height: 720 });
    expect(parseCall(meta, [{ type: 'wardrobe', tall: true }])).toMatchObject({ height: 2400 });
    expect(parseCall(meta, [{ type: 'wall', tall: true }])).toMatchObject({ height: 720 });
  });

  it("is what the editor's preview completes, and what FeatureMetas.defaultIn says", () => {
    const meta = resolved();
    expect(FeatureMetas.complete(meta, { type: 'wall' })).toMatchObject({ height: 720 });
    expect(FeatureMetas.defaultIn(meta.params.height, { type: 'wardrobe' })).toBe(2400);
    expect(FeatureMetas.defaultIn(meta.params.height, { type: 'base' })).toBe(900);
    expect(FeatureMetas.defaultOf(meta.params.height)).toBe(900);
  });

  it("fills a feature's this.values through Feature.with", () => {
    class Cabinet extends Feature.with(CABINET as never) {
      static id = 'acme.cabinet';
      buildTool(): Shape[] {
        return [];
      }
    }
    const schema = ValueSchema.declare((Cabinet as unknown as { params: unknown }).params, "feature 'acme.cabinet'");
    expect(schema.complete('cabinet()', { type: 'wall' })).toMatchObject({ type: 'wall', height: 720, depth: 560 });
  });

  it("fills a generator's values and a generated assembly's insert", () => {
    class Cabinets extends Generator.with(CABINET as never) {
      static id = 'acme.cabinets';
      layout() {
        return {};
      }
      static build(): Shape[] {
        return [];
      }
    }
    const def = defineAssembly(Cabinets, { label: 'Cabinets' }) as unknown as { completedValues(read: Record<string, unknown>): Record<string, unknown> };
    expect(def.completedValues({ type: 'wall' })).toEqual({ type: 'wall', height: 720, depth: 560 });
    expect(def.completedValues({ type: 'wardrobe', height: 2000 })).toEqual({ type: 'wardrobe', height: 2000, depth: 560 });
    expect(Generator.schemaOf(Cabinets)!.complete('x', {})).toMatchObject({ type: 'base', height: 900 });
  });

  it("fills a generated part's insert", () => {
    class Carcass extends Feature.with(CABINET as never, {}) {
      static id = 'acme.carcass';
      buildTool(): Shape[] {
        return [];
      }
    }
    const def = definePart(Carcass, { label: 'Carcass' }) as unknown as { completedValues(read: Record<string, unknown>): Record<string, unknown> };
    expect(def.completedValues({ type: 'wardrobe' })).toEqual({ type: 'wardrobe', height: 2400, depth: 560 });
    expect(def.completedValues({})).toEqual({ type: 'base', height: 900, depth: 560 });
  });
});

describe("conditional defaults: what the editor reads", () => {
  it("carries 'defaults' into the snapshot verbatim, the plain default beside it", () => {
    const { height } = snapshotFeatureMeta(resolved()).params as Record<string, Record<string, unknown>>;
    expect(height).toEqual({ ...HEIGHT, label: 'Height' });
  });

  it("carries them into a generated definition's schema", () => {
    class Cabinets extends Generator.with(CABINET as never) {
      static id = 'acme.cabinets';
      layout() {
        return {};
      }
      static build(): Shape[] {
        return [];
      }
    }
    const def = defineAssembly(Cabinets, { label: 'Cabinets' });
    const schema = (def as unknown as { getSchema(): { params: Record<string, unknown> } }).getSchema();
    expect(GeneratedSchemas.isGenerated(def)).toBe(true);
    expect(schema.params.height).toMatchObject({ default: 900, defaults: HEIGHT.defaults });
  });

  it("speaks the one 'when' grammar ValueSchema and the dialog read", () => {
    expect(ValueConditions.holds({ type: ['wall', 'wardrobe'] }, { type: 'wall' })).toBe(true);
    expect(ValueConditions.holds({ type: 'wall' }, {})).toBe(false);
    expect(ValueConditions.holds({ at: { picked: true } }, { at: { picks: ['planar'] } })).toBe(true);
    expect(ValueConditions.holds({ at: { picked: true } }, {})).toBe(false);
    expect(ValueConditions.defaultIn(HEIGHT as never, { type: 'wall' }, 900)).toBe(720);
    expect(ValueConditions.defaultIn(HEIGHT as never, { type: 'base' }, 900)).toBe(900);
    expect(ValueConditions.namedByDefaults(HEIGHT as never)).toEqual(['type']);
    expect(ValueSchema.holds({ type: 'wall' }, { type: 'wall' })).toBe(true);
  });
});
