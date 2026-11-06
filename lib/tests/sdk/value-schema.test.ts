// ValueSchema: the one class that checks and defaults a schema's values —
// a feature's call, a generated part's insert by id (and S2's generators).
// The feature path's own behaviour is pinned by meta.test.ts and
// define-feature.test.ts; these hold the schema's own surface.

import { describe, it, expect } from "vitest";
import { ValueSchema } from "../../sdk/value-schema.js";
import { GIVEN_VALUES } from "../../sdk/feature-inputs.js";
import { SPUR_PARAMS } from "../fixtures/custom-features/spur.js";

describe("ValueSchema", () => {
  it("checks declarations as a feature's metadata does, refusals led by who declares them", () => {
    expect(() => ValueSchema.declare({ teeth: { type: 'integer', default: 2.5 } }, "feature 'acme.spur'"))
      .toThrow("feature 'acme.spur': param 'teeth': the default of an integer must be a whole number, got 2.5");
    expect(() => ValueSchema.declare({ at: { picker: 'face', default: 1 } }, 'generator'))
      .toThrow("generator: param 'at': a picker takes no default — its value is what the user picks");
  });

  it("is one schema per resolved declarations, in declaration order", () => {
    const schema = ValueSchema.declare(SPUR_PARAMS, 'spur');
    expect(ValueSchema.of(schema.params)).toBe(schema);
    expect(schema.names()).toEqual(['at', 'teeth', 'module', 'width', 'style']);
    expect(schema.pickerNames()).toEqual(['at']);
  });

  it("leaves the picked values out of its typed-in schema", () => {
    const typed = ValueSchema.declare(SPUR_PARAMS, 'spur').typedIn();
    expect(typed.names()).toEqual(['teeth', 'module', 'width', 'style']);
    expect(typed.has('at')).toBe(false);
  });

  it("completes values by id: defaults filled, each checked, the given names recorded, led by the subject", () => {
    const typed = ValueSchema.declare(SPUR_PARAMS, 'spur').typedIn();
    const values = typed.complete("part 'Spur'", { teeth: 18 });
    expect(values).toEqual({ teeth: 18, module: 2, width: 10, style: 'spur' });
    expect([...(values as unknown as Record<symbol, Set<string>>)[GIVEN_VALUES]]).toEqual(['teeth']);
    expect(() => typed.complete("part 'Spur'", { width: 0 })).toThrow("part 'Spur': 'width' must be at least 0.01, got 0");
    expect(() => typed.complete("part 'Spur'", { style: 'bevel' })).toThrow(`part 'Spur': 'style' must be one of "spur", "helical", got 'bevel'`);
  });

  it("refuses a name it doesn't declare, suggesting the nearest, or explaining one declared elsewhere", () => {
    const full = ValueSchema.declare(SPUR_PARAMS, 'spur');
    const typed = full.typedIn();
    expect(() => typed.refuseUnknown('gear', { modul: 3 }))
      .toThrow("gear: 'modul' is not one of its values — did you mean 'module'? its values are teeth, module, width, style");
    expect(() => typed.refuseUnknown('gear', { colour: 'red' }))
      .toThrow("gear: 'colour' is not one of its values — its values are teeth, module, width, style");
    expect(() => typed.refuseUnknown('gear', { at: 1 }, name => (full.has(name) ? 'is picked' : null))).toThrow("gear: 'at' is picked");
    expect(() => typed.refuseUnknown('gear', { teeth: 3 })).not.toThrow();
  });

  it("snapshots its values as a feature's metadata snapshot lists them", () => {
    const typed = ValueSchema.declare(SPUR_PARAMS, 'spur').typedIn();
    expect(typed.snapshot().width).toEqual({ type: 'length', default: 10, min: 0.01, label: 'Face width' });
    expect(typed.snapshot().teeth.label).toBe('Teeth');
  });
});
