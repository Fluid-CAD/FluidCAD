import { describe, it, expect } from 'vitest';
import {
  allConfigurationTargets,
  parseConfigurationOptions,
  sanitizeConfigurationName,
} from '../lib/export-configurations.js';

// `fluidcad export … --configuration / --all-configurations`
// (docs/assembly-configurations-plan.md §3.7): the flag checks and the file
// each row lands in.

describe('parseConfigurationOptions', () => {
  it('is null without either flag — the row on screen exports', () => {
    expect(parseConfigurationOptions({})).toBeNull();
  });

  it('names one row', () => {
    expect(parseConfigurationOptions({ configuration: 'Wide' })).toEqual({ kind: 'one', name: 'Wide' });
    expect(parseConfigurationOptions({ configuration: ' Default ' })).toEqual({ kind: 'one', name: 'Default' });
  });

  it('asks for every row', () => {
    expect(parseConfigurationOptions({ allConfigurations: true })).toEqual({ kind: 'all' });
  });

  it('refuses an empty name, both flags together, all rows with --list-shapes, and all rows for a png', () => {
    expect(() => parseConfigurationOptions({ configuration: '  ' })).toThrow(/needs a configuration name/);
    expect(() => parseConfigurationOptions({ configuration: 'Wide', allConfigurations: true })).toThrow(/not both/);
    expect(() => parseConfigurationOptions({ allConfigurations: true, listShapes: true })).toThrow(/list-shapes/);
    expect(() => parseConfigurationOptions({ allConfigurations: true }, { allowAll: false })).toThrow(/STEP and STL only/);
    expect(parseConfigurationOptions({ configuration: 'Wide' }, { allowAll: false })).toEqual({ kind: 'one', name: 'Wide' });
  });
});

describe('sanitizeConfigurationName', () => {
  it('keeps a plain name and makes the rest file-safe', () => {
    expect(sanitizeConfigurationName('Wide')).toBe('Wide');
    expect(sanitizeConfigurationName('Extra wide / 1200')).toBe('Extra-wide-1200');
    expect(sanitizeConfigurationName('M8 (zinc)')).toBe('M8-zinc');
    expect(sanitizeConfigurationName('Größe')).toBe('Gro-e');
    expect(sanitizeConfigurationName('Café')).toBe('Cafe');
    expect(sanitizeConfigurationName('../x')).toBe('x');
    expect(sanitizeConfigurationName('***')).toBe('configuration');
  });
});

describe('allConfigurationTargets', () => {
  it('writes Default as <model>.<ext> and each row as <model>-<Row>.<ext>, in declaration order', () => {
    expect(allConfigurationTargets(['Wide', 'Compact'], { modelName: 'frame', extension: '.step', cwd: '/out' })).toEqual([
      { configuration: 'Default', outPath: '/out/frame.step' },
      { configuration: 'Wide', outPath: '/out/frame-Wide.step' },
      { configuration: 'Compact', outPath: '/out/frame-Compact.step' },
    ]);
  });

  it('is Default alone for a model without a table', () => {
    expect(allConfigurationTargets([], { modelName: 'frame', extension: '.stl', cwd: '/out' })).toEqual([
      { configuration: 'Default', outPath: '/out/frame.stl' },
    ]);
  });

  it('takes -o as the base name, its extension dropped', () => {
    expect(allConfigurationTargets(['Wide'], { outOption: '/exports/rack.step', modelName: 'frame', extension: '.step' })).toEqual([
      { configuration: 'Default', outPath: '/exports/rack.step' },
      { configuration: 'Wide', outPath: '/exports/rack-Wide.step' },
    ]);
    expect(allConfigurationTargets(['Wide'], { outOption: '/exports/rack', modelName: 'frame', extension: '.stl' })[1].outPath)
      .toBe('/exports/rack-Wide.stl');
  });

  it('never lets two rows share a file', () => {
    const targets = allConfigurationTargets(['A b', 'A/b', 'a-B'], { modelName: 'm', extension: '.step', cwd: '/o' });
    expect(targets.map((t) => t.outPath)).toEqual(['/o/m.step', '/o/m-A-b.step', '/o/m-A-b-2.step', '/o/m-a-B-3.step']);
  });
});
