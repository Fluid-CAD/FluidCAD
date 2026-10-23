import { describe, it, expect } from 'vitest';
import {
  allConfigurationTargets,
  collectConfigurationExports,
  defaultSelector,
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

describe('defaultSelector', () => {
  it('exports every solid of the scene exported for a file that is not an assembly', () => {
    expect(defaultSelector({ assembly: false, requested: null })).toEqual({ shapeIds: 'all' });
  });

  it('exports an assembly whole', () => {
    expect(defaultSelector({ assembly: true, requested: null })).toEqual({ assembly: {} });
  });

  it('leaves --shapes to resolve to ids of the scene on screen', () => {
    expect(defaultSelector({ assembly: false, requested: ['1'] })).toBeNull();
    expect(defaultSelector({ assembly: true, requested: ['Boss'] })).toBeNull();
  });
});

describe('collectConfigurationExports', () => {
  const targets = [
    { configuration: 'Default', outPath: '/o/plate.step' },
    { configuration: 'Plain', outPath: '/o/plate-Plain.step' },
    { configuration: 'WithBoss', outPath: '/o/plate-WithBoss.step' },
  ];

  it('exports every row, in order, before handing any file back', async () => {
    const asked: string[] = [];
    const files = await collectConfigurationExports(
      targets,
      async (configuration: string) => {
        asked.push(configuration);
        return { ok: true, buffer: Buffer.from(configuration) };
      },
      () => 'unused',
    );
    expect(asked).toEqual(['Default', 'Plain', 'WithBoss']);
    expect(files.map((f: any) => [f.outPath, f.buffer.toString()])).toEqual([
      ['/o/plate.step', 'Default'],
      ['/o/plate-Plain.step', 'Plain'],
      ['/o/plate-WithBoss.step', 'WithBoss'],
    ]);
  });

  it('stops at a row that fails, naming it, and hands back nothing', async () => {
    const asked: string[] = [];
    await expect(collectConfigurationExports(
      targets,
      async (configuration: string) => {
        asked.push(configuration);
        return configuration === 'Plain' ? { ok: false, status: 400 } : { ok: true, buffer: Buffer.from('x') };
      },
      (result: { status: number }) => `HTTP ${result.status}: Configuration 'Plain' does not build Solid 2 (Boss).`,
    )).rejects.toThrow("Export of Plain failed, so nothing was written: HTTP 400: Configuration 'Plain' does not build Solid 2 (Boss).");
    expect(asked).toEqual(['Default', 'Plain']);
  });
});
