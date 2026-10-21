// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { ExportDialog, exportBaseName, type ExportAssemblyProvider } from '../src/ui/export-dialog';
import type { EngineClient } from '../src/engine-client';
import type { SceneContext } from '../src/scene/scene-context';
import { EVERY_SOLID, type MeasurePose } from '../src/api';
import type { SceneDocument } from '../src/units/scene-document';

// The export dialog's two targets. Shapes: the listed solids, as before.
// Assembly: the whole assembly where its parts sit — the body carries one
// live pose per instance (the browser solver owns them, the server only knows
// the statement pose), the download is named after the assembly file, and an
// instance the solver has not placed yet stops the export before any request.
// A part scene's solids name their file: the download is called after it and
// the dialog offers the file's configurations() rows, as for the assembly.

vi.mock('../src/desktop', () => ({
  deliverFile: vi.fn(async () => 'downloaded'),
}));

vi.mock('../src/screenshot', () => ({
  captureScreenshot: vi.fn(async () => new Blob(['png'])),
}));

import { deliverFile } from '../src/desktop';

const deliverFileMock = vi.mocked(deliverFile);

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

const POSES: Record<string, MeasurePose> = {
  'inst-a': { position: { x: 1, y: 2, z: 3 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } },
  'inst-b': { position: { x: -4, y: 0, z: 9 }, quaternion: { x: 0, y: 0.7071, z: 0, w: 0.7071 } },
};

function provider(poseOf: (id: string) => MeasurePose | null = (id) => POSES[id] ?? null): ExportAssemblyProvider {
  return {
    instances: () => [
      { instanceId: 'inst-a', name: 'Housing' },
      { instanceId: 'inst-b', name: 'Lid 2' },
    ],
    poseOf,
    fileBaseName: () => 'robot',
  };
}

function mount(assembly: ExportAssemblyProvider | null = null) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const exportShapes = vi.fn(async () => new Blob(['step']));
  const client = { exportShapes } as unknown as EngineClient;
  const dialog = new ExportDialog(container, client, {} as SceneContext, assembly);
  const q = <T extends HTMLElement>(ref: string): T => container.querySelector<T>(`[data-ref="${ref}"]`)!;
  const pickFormat = (format: string): void => {
    const pill = container.querySelector<HTMLInputElement>(`[data-format="${format}"]`)!;
    pill.checked = true;
    pill.dispatchEvent(new Event('change'));
  };
  return { dialog, container, exportShapes, q, pickFormat };
}

async function clickExport(q: <T extends HTMLElement>(ref: string) => T): Promise<void> {
  q<HTMLButtonElement>('export-btn').click();
  await vi.waitFor(() => {
    // Either a request went out and the file was delivered, or the status
    // line explains why nothing did.
    if (deliverFileMock.mock.calls.length > 0) {
      return;
    }
    const status = q('status');
    if (status.classList.contains('hidden') || status.textContent?.includes('Exporting')) {
      throw new Error('still exporting');
    }
  });
}

describe('ExportDialog shapes target', () => {
  it('posts the shape ids and downloads export.step', async () => {
    const { dialog, exportShapes, q } = mount();
    dialog.show({ kind: 'shapes', shapeIds: ['s-1', 's-2'] });
    expect(q('title').textContent).toBe('Export');
    expect(q('purpose').classList.contains('hidden')).toBe(true);

    await clickExport(q);

    expect(exportShapes).toHaveBeenCalledWith({ format: 'step', shapeIds: ['s-1', 's-2'], includeColors: true });
    expect(deliverFileMock.mock.calls[0][1]).toBe('export.step');
  });

  it('STL carries the mesh options', async () => {
    const { dialog, exportShapes, q, pickFormat } = mount();
    dialog.show({ kind: 'shapes', shapeIds: ['s-1'] });
    pickFormat('stl');

    await clickExport(q);

    expect(exportShapes).toHaveBeenCalledWith({
      format: 'stl',
      shapeIds: ['s-1'],
      resolution: 'medium',
      scaleTo: 'mm',
    });
    expect(deliverFileMock.mock.calls[0][1]).toBe('export.stl');
  });

  it('names a part scene\'s download after its file, with or without configurations', async () => {
    const { dialog, exportShapes, q, pickFormat } = mount();
    dialog.show({ kind: 'shapes', shapeIds: ['s-1'], fileBase: 'plate' });
    expect(q('configuration-section').classList.contains('hidden')).toBe(true);

    await clickExport(q);
    expect(exportShapes).toHaveBeenCalledWith({ format: 'step', shapeIds: ['s-1'], includeColors: true });
    expect(deliverFileMock.mock.calls[0][1]).toBe('plate.step');

    deliverFileMock.mockClear();
    dialog.show({ kind: 'shapes', shapeIds: ['s-1'], fileBase: 'plate' });
    pickFormat('png');
    await clickExport(q);
    expect(deliverFileMock.mock.calls[0][1]).toBe('plate.png');
  });
});

describe('ExportDialog assembly target', () => {
  it('posts one live pose per instance and downloads <file>.step', async () => {
    const { dialog, exportShapes, q } = mount(provider());
    dialog.show({ kind: 'assembly' });
    expect(q('title').textContent).toBe('Export assembly');
    expect(q('purpose').classList.contains('hidden')).toBe(false);
    expect(q('purpose').textContent).toContain('Every part where it sits');

    await clickExport(q);

    expect(exportShapes).toHaveBeenCalledTimes(1);
    const body = exportShapes.mock.calls[0][0] as Record<string, unknown>;
    expect(body).toEqual({
      format: 'step',
      includeColors: true,
      assembly: {
        poses: [
          { instanceId: 'inst-a', position: { x: 1, y: 2, z: 3 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } },
          { instanceId: 'inst-b', position: { x: -4, y: 0, z: 9 }, quaternion: { x: 0, y: 0.7071, z: 0, w: 0.7071 } },
        ],
      },
    });
    expect('shapeIds' in body).toBe(false);
    expect(deliverFileMock.mock.calls[0][1]).toBe('robot.step');
  });

  it('STL names the download after the file too', async () => {
    const { dialog, exportShapes, q, pickFormat } = mount(provider());
    dialog.show({ kind: 'assembly' });
    pickFormat('stl');

    await clickExport(q);

    const body = exportShapes.mock.calls[0][0] as Record<string, unknown>;
    expect(body.format).toBe('stl');
    expect(body.resolution).toBe('medium');
    expect(deliverFileMock.mock.calls[0][1]).toBe('robot.stl');
  });

  it('a missing live pose shows a readable error and sends nothing', async () => {
    const { dialog, exportShapes, q } = mount(provider((id) => (id === 'inst-b' ? null : POSES[id])));
    dialog.show({ kind: 'assembly' });

    await clickExport(q);

    expect(exportShapes).not.toHaveBeenCalled();
    expect(deliverFileMock).not.toHaveBeenCalled();
    expect(q('status').classList.contains('hidden')).toBe(false);
    expect(q('status').textContent).toContain('"Lid 2" has no position yet');
    expect(q<HTMLButtonElement>('export-btn').disabled).toBe(false);
  });

  it('without an assembly provider the target explains itself', async () => {
    const { dialog, exportShapes, q } = mount(null);
    dialog.show({ kind: 'assembly' });

    await clickExport(q);

    expect(exportShapes).not.toHaveBeenCalled();
    expect(q('status').textContent).toContain('No assembly is open');
  });

  it('reopening on shapes restores the plain title', () => {
    const { dialog, q } = mount(provider());
    dialog.show({ kind: 'assembly' });
    dialog.show({ kind: 'shapes', shapeIds: ['s-1'] });
    expect(q('title').textContent).toBe('Export');
    expect(q('purpose').classList.contains('hidden')).toBe(true);
  });
});

const TABLE = {
  active: 'Wide',
  names: ['Compact', 'Wide', 'Extra tall'],
  rows: { Compact: { Width: 500 }, Wide: { Width: 1200 }, 'Extra tall': { Height: 900 } },
  modified: false,
};

function pickConfiguration(q: <T extends HTMLElement>(ref: string) => T, label: string): void {
  const select = q<HTMLSelectElement>('configuration');
  const option = [...select.options].find((o) => o.textContent === label);
  if (!option) {
    throw new Error(`no option "${label}"`);
  }
  select.value = option.value;
  select.dispatchEvent(new Event('change'));
}

function selectedLabel(q: <T extends HTMLElement>(ref: string) => T): string | undefined {
  const select = q<HTMLSelectElement>('configuration');
  return select.selectedOptions[0]?.textContent ?? undefined;
}

async function waitForStatus(q: <T extends HTMLElement>(ref: string) => T, done: () => boolean): Promise<void> {
  await vi.waitFor(() => {
    if (!done()) {
      throw new Error('still exporting');
    }
  });
}

describe('ExportDialog configurations', () => {
  it('offers no Configuration select without configurations() rows, and sends no configuration', async () => {
    const { dialog, exportShapes, q } = mount(provider());
    dialog.setConfigurations({ active: 'Default', names: [], rows: {}, modified: false });
    dialog.show({ kind: 'assembly' });
    expect(q('configuration-section').classList.contains('hidden')).toBe(true);

    await clickExport(q);

    expect(exportShapes.mock.calls[0][0]).not.toHaveProperty('configuration');
  });

  it('offers no Configuration select for solids that name no file (an assembly\'s part template), which export what is on screen', async () => {
    const { dialog, exportShapes, q } = mount(provider());
    dialog.setConfigurations(TABLE);
    dialog.show({ kind: 'shapes', shapeIds: ['s-1'] });
    expect(q('configuration-section').classList.contains('hidden')).toBe(true);

    await clickExport(q);

    expect(exportShapes.mock.calls[0][0]).not.toHaveProperty('configuration');
  });

  it('sits above the format pills for the whole assembly, listing Default, the rows and All configurations', () => {
    const { dialog, container, q } = mount(provider());
    dialog.setConfigurations(TABLE);
    dialog.show({ kind: 'assembly' });
    const section = q('configuration-section');
    expect(section.classList.contains('hidden')).toBe(false);
    const pills = container.querySelector('[data-ref="format-pills"]')!;
    expect(section.compareDocumentPosition(pills) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...q<HTMLSelectElement>('configuration').options].map((o) => o.textContent)).toEqual([
      'Default', 'Compact', 'Wide (on screen)', 'Extra tall', 'All configurations (.zip)',
    ]);
    expect(selectedLabel(q)).toBe('Wide (on screen)');
    expect(q('configuration-note').classList.contains('hidden')).toBe(true);
  });

  it('sends the picked row, and says an off-screen row is not where the mates put it', async () => {
    const { dialog, exportShapes, q } = mount(provider());
    dialog.setConfigurations(TABLE);
    dialog.show({ kind: 'assembly' });
    pickConfiguration(q, 'Compact');
    expect(q('configuration-note').classList.contains('hidden')).toBe(false);
    expect(q('configuration-note').textContent).toContain('not where the mates do');

    await clickExport(q);

    expect(exportShapes).toHaveBeenCalledTimes(1);
    expect((exportShapes.mock.calls[0][0] as any).configuration).toBe('Compact');
    expect((exportShapes.mock.calls[0][0] as any).assembly.poses).toHaveLength(2);
    expect(deliverFileMock.mock.calls[0][1]).toBe('robot.step');
  });

  it('follows the row on screen across renders, keeps a pick made while open, and drops one the table lost', () => {
    const { dialog, q } = mount(provider());
    dialog.setConfigurations(TABLE);
    dialog.show({ kind: 'assembly' });
    dialog.setConfigurations({ ...TABLE, active: 'Compact' });
    expect(selectedLabel(q)).toBe('Compact (on screen)');

    pickConfiguration(q, 'Extra tall');
    dialog.setConfigurations({ ...TABLE, active: 'Wide' });
    expect(selectedLabel(q)).toBe('Extra tall');

    // Renamed away: back to the screen.
    dialog.setConfigurations({ ...TABLE, names: ['Compact', 'Wide', 'Tall'] });
    expect(selectedLabel(q)).toBe('Wide (on screen)');

    pickConfiguration(q, 'All configurations (.zip)');
    dialog.setConfigurations({ ...TABLE, active: 'Compact' });
    expect(selectedLabel(q)).toBe('All configurations (.zip)');

    // Reopening starts on the screen again.
    dialog.show({ kind: 'assembly' });
    expect(selectedLabel(q)).toBe('Compact (on screen)');
  });

  it('holds the select on the row on screen for a PNG and gives the pick back for STEP', () => {
    const { dialog, q, pickFormat } = mount(provider());
    dialog.setConfigurations(TABLE);
    dialog.show({ kind: 'assembly' });
    pickConfiguration(q, 'Compact');
    pickFormat('png');
    expect(q<HTMLSelectElement>('configuration').disabled).toBe(true);
    expect(selectedLabel(q)).toBe('Wide (on screen)');
    expect(q('configuration-note').textContent).toBe('A PNG captures the configuration on screen.');
    pickFormat('step');
    expect(q<HTMLSelectElement>('configuration').disabled).toBe(false);
    expect(selectedLabel(q)).toBe('Compact');
  });

  it('All configurations exports Default and every row in turn into one zip', async () => {
    const { dialog, container, exportShapes, q, pickFormat } = mount(provider());
    exportShapes.mockImplementation(async (body: any) => new Blob([`solid ${body.configuration}`]));
    dialog.setConfigurations(TABLE);
    dialog.show({ kind: 'assembly' });
    pickFormat('stl');
    pickConfiguration(q, 'All configurations (.zip)');
    expect(q('configuration-note').textContent).toContain('one .zip');

    q<HTMLButtonElement>('export-btn').click();
    await waitForStatus(q, () => deliverFileMock.mock.calls.length > 0);

    expect(exportShapes.mock.calls.map((call) => (call[0] as any).configuration)).toEqual(['Default', 'Compact', 'Wide', 'Extra tall']);
    expect(exportShapes.mock.calls.every((call) => (call[0] as any).format === 'stl' && (call[0] as any).assembly)).toBe(true);
    expect(deliverFileMock).toHaveBeenCalledTimes(1);
    const [archive, name, filters] = deliverFileMock.mock.calls[0];
    expect(name).toBe('robot-configurations.zip');
    expect(filters).toEqual([{ name: 'ZIP Archives', extensions: ['zip'] }]);
    const zip = await JSZip.loadAsync(await archive.arrayBuffer());
    expect(Object.keys(zip.files)).toEqual(['robot.stl', 'robot-Compact.stl', 'robot-Wide.stl', 'robot-Extra-tall.stl']);
    expect(await zip.file('robot-Extra-tall.stl')!.async('string')).toBe('solid Extra tall');
    // Delivered: the dialog closes.
    expect(container.firstElementChild!.classList.contains('hidden')).toBe(true);
  });

  it('All configurations stops at a failed row, names it, and delivers nothing', async () => {
    const { dialog, exportShapes, q } = mount(provider());
    exportShapes.mockImplementation(async (body: any) => {
      if (body.configuration === 'Wide') {
        throw new Error('Unknown configuration');
      }
      return new Blob(['step']);
    });
    dialog.setConfigurations(TABLE);
    dialog.show({ kind: 'assembly' });
    pickConfiguration(q, 'All configurations (.zip)');

    q<HTMLButtonElement>('export-btn').click();
    await waitForStatus(q, () => q('status').querySelector('.text-error') !== null);

    expect(exportShapes).toHaveBeenCalledTimes(3);
    expect(deliverFileMock).not.toHaveBeenCalled();
    expect(q('status').textContent).toBe('Wide: Unknown configuration');
    expect(q<HTMLButtonElement>('export-btn').disabled).toBe(false);
  });

  it('closing the dialog abandons an All configurations run', async () => {
    const { dialog, exportShapes, q } = mount(provider());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    exportShapes.mockImplementation(async () => {
      await gate;
      return new Blob(['step']);
    });
    dialog.setConfigurations(TABLE);
    dialog.show({ kind: 'assembly' });
    pickConfiguration(q, 'All configurations (.zip)');

    q<HTMLButtonElement>('export-btn').click();
    await waitForStatus(q, () => exportShapes.mock.calls.length === 1);
    dialog.hide();
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(exportShapes).toHaveBeenCalledTimes(1);
    expect(deliverFileMock).not.toHaveBeenCalled();
  });
});

describe('ExportDialog configurations in a part scene', () => {
  const PART_TABLE = {
    active: 'Default',
    names: ['M6', 'M8'],
    rows: { M6: { Hole: 6 }, M8: { Hole: 8 } },
    modified: false,
  };
  const partTarget = { kind: 'shapes' as const, shapeIds: ['s-1', 's-2'], fileBase: 'plate' };

  it('offers the select for a part scene\'s solids, without the assembly\'s poses note', () => {
    const { dialog, q } = mount();
    dialog.setConfigurations(PART_TABLE);
    dialog.show(partTarget);
    expect(q('configuration-section').classList.contains('hidden')).toBe(false);
    expect([...q<HTMLSelectElement>('configuration').options].map((o) => o.textContent)).toEqual([
      'Default (on screen)', 'M6', 'M8', 'All configurations (.zip)',
    ]);
    pickConfiguration(q, 'M8');
    expect(q('configuration-note').classList.contains('hidden')).toBe(true);
    pickConfiguration(q, 'All configurations (.zip)');
    expect(q('configuration-note').textContent).toBe('Each configuration is its own file in one .zip.');
  });

  it('sends the picked row with the shape ids and names the file after the part', async () => {
    const { dialog, exportShapes, q } = mount();
    dialog.setConfigurations(PART_TABLE);
    dialog.show(partTarget);
    pickConfiguration(q, 'M8');

    await clickExport(q);

    expect(exportShapes).toHaveBeenCalledWith({
      format: 'step', shapeIds: ['s-1', 's-2'], includeColors: true, configuration: 'M8',
    });
    expect(deliverFileMock.mock.calls[0][1]).toBe('plate.step');
  });

  it('sends the row on screen when nothing was picked', async () => {
    const { dialog, exportShapes, q } = mount();
    dialog.setConfigurations({ ...PART_TABLE, active: 'M6' });
    dialog.show(partTarget);

    await clickExport(q);

    expect((exportShapes.mock.calls[0][0] as any).configuration).toBe('M6');
  });

  it('All configurations exports every row\'s solids into <file>-configurations.zip', async () => {
    const { dialog, exportShapes, q } = mount();
    exportShapes.mockImplementation(async (body: any) => new Blob([`step ${body.configuration}`]));
    dialog.setConfigurations(PART_TABLE);
    dialog.show(partTarget);
    pickConfiguration(q, 'All configurations (.zip)');

    q<HTMLButtonElement>('export-btn').click();
    await waitForStatus(q, () => deliverFileMock.mock.calls.length > 0);

    expect(exportShapes.mock.calls.map((call) => (call[0] as any).configuration)).toEqual(['Default', 'M6', 'M8']);
    expect(exportShapes.mock.calls.every((call) => {
      const body = call[0] as any;
      return body.format === 'step' && body.shapeIds.join() === 's-1,s-2' && !('assembly' in body);
    })).toBe(true);
    const [archive, name] = deliverFileMock.mock.calls[0];
    expect(name).toBe('plate-configurations.zip');
    const zip = await JSZip.loadAsync(await archive.arrayBuffer());
    expect(Object.keys(zip.files)).toEqual(['plate.step', 'plate-M6.step', 'plate-M8.step']);
    expect(await zip.file('plate-M8.step')!.async('string')).toBe('step M8');
  });

  it('holds the select on the row on screen for a PNG', () => {
    const { dialog, q, pickFormat } = mount();
    dialog.setConfigurations(PART_TABLE);
    dialog.show(partTarget);
    pickConfiguration(q, 'M8');
    pickFormat('png');
    expect(q<HTMLSelectElement>('configuration').disabled).toBe(true);
    expect(selectedLabel(q)).toBe('Default (on screen)');
    expect(q('configuration-note').textContent).toBe('A PNG captures the configuration on screen.');
  });
});

describe('ExportDialog.shapesTarget', () => {
  const doc = (absPath: string, kind: SceneDocument['kind']): SceneDocument => ({ absPath, kind, declaredUnit: null, projectUnit: 'mm' });

  it('names a part scene\'s target after its file, every solid or listed ones', () => {
    expect(ExportDialog.shapesTarget(EVERY_SOLID, doc('/work/plate.part.js', 'part'))).toEqual({ kind: 'shapes', shapeIds: 'all', fileBase: 'plate' });
    expect(ExportDialog.shapesTarget(['s-1'], doc('/work/plate.part.js', 'part'))).toEqual({ kind: 'shapes', shapeIds: ['s-1'], fileBase: 'plate' });
  });

  it('leaves an assembly\'s part templates, and a host without a document, unnamed', () => {
    expect(ExportDialog.shapesTarget(['s-1'], doc('/work/robot.assembly.js', 'assembly'))).toEqual({ kind: 'shapes', shapeIds: ['s-1'] });
    expect(ExportDialog.shapesTarget(EVERY_SOLID, null)).toEqual({ kind: 'shapes', shapeIds: 'all' });
  });
});

describe('ExportDialog every solid of a part scene (File ▸ Export)', () => {
  const PART_TABLE = {
    active: 'Default',
    names: ['Plain', 'WithBoss'],
    rows: { Plain: { Boss: 0 }, WithBoss: { Boss: 1 } },
    modified: false,
  };
  const partDoc: SceneDocument = { absPath: '/work/plate.part.js', kind: 'part', declaredUnit: null, projectUnit: 'mm' };

  it('asks the server for every solid of the picked row, never the ids on screen', async () => {
    const { dialog, exportShapes, q } = mount();
    dialog.setConfigurations(PART_TABLE);
    dialog.show(ExportDialog.shapesTarget(EVERY_SOLID, partDoc));
    pickConfiguration(q, 'WithBoss');

    await clickExport(q);

    expect(exportShapes).toHaveBeenCalledWith({ format: 'step', shapeIds: 'all', includeColors: true, configuration: 'WithBoss' });
    expect(deliverFileMock.mock.calls[0][1]).toBe('plate.step');
  });

  it('without rows it is every solid of the scene on screen, named after the part', async () => {
    const { dialog, exportShapes, q, pickFormat } = mount();
    dialog.show(ExportDialog.shapesTarget(EVERY_SOLID, partDoc));
    pickFormat('stl');

    await clickExport(q);

    expect(exportShapes).toHaveBeenCalledWith({ format: 'stl', shapeIds: 'all', resolution: 'medium', scaleTo: 'mm' });
    expect(deliverFileMock.mock.calls[0][1]).toBe('plate.stl');
  });

  it('All configurations asks every row for its own solids', async () => {
    const { dialog, exportShapes, q } = mount();
    exportShapes.mockImplementation(async (body: any) => new Blob([`step ${body.configuration}`]));
    dialog.setConfigurations(PART_TABLE);
    dialog.show(ExportDialog.shapesTarget(EVERY_SOLID, partDoc));
    pickConfiguration(q, 'All configurations (.zip)');

    q<HTMLButtonElement>('export-btn').click();
    await waitForStatus(q, () => deliverFileMock.mock.calls.length > 0);

    expect(exportShapes.mock.calls.map((call) => call[0])).toEqual([
      { format: 'step', shapeIds: 'all', includeColors: true, configuration: 'Default' },
      { format: 'step', shapeIds: 'all', includeColors: true, configuration: 'Plain' },
      { format: 'step', shapeIds: 'all', includeColors: true, configuration: 'WithBoss' },
    ]);
    expect(deliverFileMock.mock.calls[0][1]).toBe('plate-configurations.zip');
  });

  it('a specific solid (timeline, top bar) still sends its id, and a row that lacks it fails the zip naming the row', async () => {
    const { dialog, exportShapes, q } = mount();
    exportShapes.mockImplementation(async (body: any) => {
      if (body.configuration === 'Plain') {
        throw new Error("Configuration 'Plain' does not build Solid 2 (Boss), which the configuration on screen does.");
      }
      return new Blob(['step']);
    });
    dialog.setConfigurations(PART_TABLE);
    dialog.show(ExportDialog.shapesTarget(['s-2'], partDoc));
    pickConfiguration(q, 'All configurations (.zip)');

    q<HTMLButtonElement>('export-btn').click();
    await waitForStatus(q, () => q('status').textContent?.includes('does not build') === true);

    expect(exportShapes.mock.calls.map((call) => (call[0] as any).shapeIds)).toEqual([['s-2'], ['s-2']]);
    expect(q('status').textContent).toBe("Plain: Configuration 'Plain' does not build Solid 2 (Boss), which the configuration on screen does.");
    expect(deliverFileMock).not.toHaveBeenCalled();
  });
});

describe('exportBaseName', () => {
  it('strips the directory and the model suffix', () => {
    expect(exportBaseName('/work/robot.assembly.js')).toBe('robot');
    expect(exportBaseName('C:\\work\\arm.assembly.js')).toBe('arm');
    expect(exportBaseName('/work/bracket.js')).toBe('bracket');
    expect(exportBaseName('/work/plate.part.js')).toBe('plate');
    expect(exportBaseName('/work/hinge.fluid.js')).toBe('hinge');
    expect(exportBaseName('')).toBe('');
  });
});
