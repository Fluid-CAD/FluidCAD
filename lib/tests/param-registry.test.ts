import { describe, it, expect } from 'vitest';
import { ParamRegistry, type ParamVal } from '../param-registry.js';

// A params-panel override is a delta over the default the source declared when
// the user moved the control. Re-authoring that literal in code is the newer
// statement of intent, so the override is dropped rather than left shadowing a
// value the file no longer asks for. Everything here is about that rule —
// overrides stay sticky for as long as their baseline holds.

function withOverrides(
  overrides: Record<string, ParamVal>,
  baselines?: Record<string, ParamVal>,
): ParamRegistry {
  const registry = new ParamRegistry();
  registry.setOverrides(
    new Map(Object.entries(overrides)),
    baselines ? new Map(Object.entries(baselines)) : undefined,
  );
  return registry;
}

describe('ParamRegistry — overrides vs. authored defaults', () => {
  it('honors an override while the source keeps declaring the same default', () => {
    const registry = withOverrides({ width: 250 }, { width: 300 });

    expect(registry.resolve('width', 300)).toBe(250);
    expect(registry.getDiscardedOverrides()).toEqual([]);
  });

  it('drops the override once the source declares a different default', () => {
    const registry = withOverrides({ width: 250 }, { width: 300 });

    expect(registry.resolve('width', 100)).toBe(100);
    expect(registry.getDiscardedOverrides()).toEqual(['width']);
  });

  it('drops only the re-authored label, leaving other overrides alone', () => {
    const registry = withOverrides({ width: 250, height: 80 }, { width: 300, height: 50 });

    expect(registry.resolve('width', 100)).toBe(100);
    expect(registry.resolve('height', 50)).toBe(80);
    expect(registry.getDiscardedOverrides()).toEqual(['width']);
  });

  it('honors an override with no baseline — the first run after it was set', () => {
    const registry = withOverrides({ width: 250 });

    expect(registry.resolve('width', 300)).toBe(250);
    expect(registry.getDiscardedOverrides()).toEqual([]);
  });

  it('compares array defaults element-wise, not by identity', () => {
    const kept = withOverrides({ sizes: ['m'] }, { sizes: ['s', 'l'] });
    expect(kept.resolve('sizes', ['s', 'l'])).toEqual(['m']);

    const dropped = withOverrides({ sizes: ['m'] }, { sizes: ['s', 'l'] });
    expect(dropped.resolve('sizes', ['s', 'xl'])).toEqual(['s', 'xl']);
    expect(dropped.getDiscardedOverrides()).toEqual(['sizes']);
  });

  it('reports the default each label was authored with, for the next run to compare', () => {
    const registry = new ParamRegistry();

    registry.resolve('width', 300);
    registry.resolve('depth', 12);

    expect(registry.getAuthoredDefaults()).toEqual(new Map([['width', 300], ['depth', 12]]));
  });

  it('lets the first param() call per label decide, so a second call cannot flip the verdict', () => {
    // Two declarations under one label: the first is the run's baseline, and a
    // second literal further down must not re-judge the override behind it.
    const registry = withOverrides({ width: 250 }, { width: 300 });

    expect(registry.resolve('width', 300)).toBe(250);
    expect(registry.resolve('width', 999)).toBe(250);
    expect(registry.getDiscardedOverrides()).toEqual([]);
    expect(registry.getAuthoredDefaults().get('width')).toBe(300);
  });

  it('keeps a discarded override discarded for the rest of the run', () => {
    const registry = withOverrides({ width: 250 }, { width: 300 });

    expect(registry.resolve('width', 100)).toBe(100);
    expect(registry.resolve('width', 100)).toBe(100);
  });
});
