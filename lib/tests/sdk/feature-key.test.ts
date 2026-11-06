import { describe, it, expect } from "vitest";
import { FeatureKey } from "../../sdk/feature-key.js";
import { FeatureMetas } from "../../sdk/meta.js";

describe("FeatureKey", () => {
  it("joins a package's public name and a plain id, and parses it back", () => {
    const key = FeatureKey.of('@acme/feature-tests', 'standoff');
    expect(key).toBe('@acme/feature-tests:standoff');
    expect(FeatureKey.parse(key)).toEqual({ packageName: '@acme/feature-tests', id: 'standoff' });
    expect(FeatureKey.idOf(key)).toBe('standoff');
  });

  it("round-trips every package and id shape", () => {
    for (const packageName of ['@acme/kit', '@bea-tools/feature-tests', '@local/feature-tests']) {
      for (const id of ['standoff', 'boltCircle', 'acme.standoff', 'bolt_circle-2']) {
        expect(FeatureKey.parse(FeatureKey.of(packageName, id))).toEqual({ packageName, id });
      }
    }
  });

  it("reads a plain id as one with no package", () => {
    expect(FeatureKey.parse('standoff')).toEqual({ packageName: null, id: 'standoff' });
    expect(FeatureKey.parse('acme.standoff')).toEqual({ packageName: null, id: 'acme.standoff' });
    expect(FeatureKey.idOf('acme.standoff')).toBe('acme.standoff');
  });

  it("names the builder by the plain id's last dot segment", () => {
    expect(FeatureKey.calleeOf('@acme/feature-tests:standoff')).toBe('standoff');
    expect(FeatureKey.calleeOf('@acme/kit:acme.standoff')).toBe('standoff');
    expect(FeatureKey.calleeOf('acme.standoff')).toBe('standoff');
    expect(FeatureKey.calleeOf('standoff')).toBe('standoff');
    expect(FeatureMetas.calleeOf('@acme/kit:acme.boltCircle')).toBe('boltCircle');
  });
});
