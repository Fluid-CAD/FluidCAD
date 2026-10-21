import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { ConfigurationExport } from '../src/ui/export-configurations';

// The export dialog's configurations() logic without the DOM: the rows an
// export offers, the select's option values, the archive's entry names
// (the CLI's --all-configurations names) and the archive itself.

const table = (names: string[], active = 'Default') => ({ active, names, rows: {}, modified: false });

describe('ConfigurationExport', () => {
  it('offers Default first, then the rows in declaration order', () => {
    expect(ConfigurationExport.rows(table(['Wide', 'Compact']))).toEqual(['Default', 'Wide', 'Compact']);
  });

  it('round-trips option values, and no row name passes for the all option', () => {
    for (const pick of [{ kind: 'all' as const }, { kind: 'one' as const, name: 'Wide' }, { kind: 'one' as const, name: 'all' }]) {
      expect(ConfigurationExport.parseOptionValue(ConfigurationExport.optionValue(pick))).toEqual(pick);
    }
    expect(ConfigurationExport.optionValue({ kind: 'one', name: 'all' })).not.toBe(ConfigurationExport.optionValue({ kind: 'all' }));
    expect(ConfigurationExport.parseOptionValue('Wide')).toBeNull();
  });

  it('knows which picks a table still offers', () => {
    const t = table(['Wide']);
    expect(ConfigurationExport.offers(t, { kind: 'all' })).toBe(true);
    expect(ConfigurationExport.offers(t, { kind: 'one', name: 'Default' })).toBe(true);
    expect(ConfigurationExport.offers(t, { kind: 'one', name: 'Wide' })).toBe(true);
    expect(ConfigurationExport.offers(t, { kind: 'one', name: 'Narrow' })).toBe(false);
  });

  it('names Default after the model and each row with a file-safe suffix', () => {
    expect(ConfigurationExport.entries(table(['Wide', 'M8 (zinc) / long', '***']), 'robot', '.step')).toEqual([
      { configuration: 'Default', fileName: 'robot.step' },
      { configuration: 'Wide', fileName: 'robot-Wide.step' },
      { configuration: 'M8 (zinc) / long', fileName: 'robot-M8-zinc-long.step' },
      { configuration: '***', fileName: 'robot-configuration.step' },
    ]);
  });

  it('numbers rows that sanitise alike, case-insensitively, so no entry overwrites another', () => {
    const names = ConfigurationExport.entries(table(['A/B', 'A B', 'a-b']), 'robot', '.stl').map((e) => e.fileName);
    expect(names).toEqual(['robot.stl', 'robot-A-B.stl', 'robot-A-B-2.stl', 'robot-a-b-3.stl']);
  });

  it('packs the files into one zip', async () => {
    const archive = await ConfigurationExport.archive([
      { fileName: 'robot.step', blob: new Blob(['ISO-10303-21; default']) },
      { fileName: 'robot-Wide.step', blob: new Blob(['ISO-10303-21; wide']) },
    ]);
    expect(archive.type).toBe('application/zip');
    const zip = await JSZip.loadAsync(await archive.arrayBuffer());
    expect(Object.keys(zip.files)).toEqual(['robot.step', 'robot-Wide.step']);
    expect(await zip.file('robot-Wide.step')!.async('string')).toBe('ISO-10303-21; wide');
    expect(ConfigurationExport.archiveName('robot')).toBe('robot-configurations.zip');
  });
});
