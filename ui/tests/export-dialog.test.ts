// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { ExportDialog, exportBaseName, type ExportAssemblyProvider } from '../src/ui/export-dialog';
import type { EngineClient } from '../src/engine-client';
import type { SceneContext } from '../src/scene/scene-context';
import { EVERY_SOLID, type ExportResult, type MeasurePose } from '../src/api';
import type { ExportViewProvider } from '../src/ui/export-drawing-views';
import { PREVIEW_DEBOUNCE_MS } from '../src/ui/export-drawing-preview';
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

// A drawing's preview is shown through an object URL, which jsdom does not
// make: each blob gets a numbered one, so a test can tell which drawing is on
// screen and which URLs were let go.
const previewBlobs = new Map<string, Blob>();
const createObjectURL = vi.fn((blob: Blob): string => {
  const url = `blob:preview-${previewBlobs.size + 1}`;
  previewBlobs.set(url, blob);
  return url;
});
const revokeObjectURL = vi.fn((_url: string): void => {});
URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;

/** Every dialog a test mounted: closed after it, so no preview still waiting on its timer outlives the test. */
const mounted: ExportDialog[] = [];

afterEach(() => {
  for (const dialog of mounted.splice(0)) {
    dialog.hide();
  }
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.useRealTimers();
  previewBlobs.clear();
});

/**
 * The export requests among a client's calls. A drawing format also asks for
 * its preview — always an SVG, never of "one row of a zip run" — a moment
 * after the options rest, so a slow export can find one among its own calls.
 */
function requestsOf(exportShapes: { mock: { calls: unknown[][] } }, format: string): any[] {
  return exportShapes.mock.calls.map((call) => call[0] as any).filter((body) => body.format === format);
}

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

function mount(assembly: ExportAssemblyProvider | null = null, view: ExportViewProvider | null = null) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  // A host answers the bare file, or the file with the export's warnings.
  const exportShapes = vi.fn(async (_body: unknown): Promise<Blob | ExportResult> => new Blob(['step']));
  const client = { exportShapes } as unknown as EngineClient;
  const dialog = new ExportDialog(container, client, {} as SceneContext, assembly, view);
  mounted.push(dialog);
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
    dialog.setConfigurations({ active: 'Default', names: [], rows: {} });
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

  it('sends the picked row, and says an off-screen row sits where its mates settle it, not as dragged', async () => {
    const { dialog, exportShapes, q } = mount(provider());
    dialog.setConfigurations(TABLE);
    dialog.show({ kind: 'assembly' });
    pickConfiguration(q, 'Compact');
    expect(q('configuration-note').classList.contains('hidden')).toBe(false);
    expect(q('configuration-note').textContent).toContain('where the mates settle them');

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

// A DXF or an SVG is a drawing of the solids' view on a standard plane: their
// own options section (the view, hidden lines, tangent edges; the stroke
// width for an SVG), a body without any STEP or STL option (the server
// refuses them with it), the view in every file name, and — for the whole
// assembly — a note in place of the options, with Export disabled.
describe('ExportDialog drawing (DXF, SVG)', () => {
  const PART_TABLE = {
    active: 'Default',
    names: ['M6', 'M8'],
    rows: { M6: { Hole: 6 }, M8: { Hole: 8 } },
  };
  const partTarget = { kind: 'shapes' as const, shapeIds: ['s-1', 's-2'], fileBase: 'plate' };
  const lookingFrom = (x: number, y: number, z: number): ExportViewProvider => ({ eyeDirection: () => ({ x, y, z }) });

  const viewLabel = (q: <T extends HTMLElement>(ref: string) => T): string | undefined =>
    q<HTMLSelectElement>('drawing-view').selectedOptions[0]?.textContent ?? undefined;
  const pickView = (q: <T extends HTMLElement>(ref: string) => T, view: string): void => {
    const select = q<HTMLSelectElement>('drawing-view');
    select.value = view;
    select.dispatchEvent(new Event('change'));
  };
  const toggle = (q: <T extends HTMLElement>(ref: string) => T, ref: string): void => {
    const input = q<HTMLInputElement>(ref);
    input.checked = !input.checked;
    input.dispatchEvent(new Event('change'));
  };

  it('lists the pills STEP, STL, DXF, SVG, PNG and shows each format its own section only', () => {
    const { dialog, container, q, pickFormat } = mount();
    dialog.show({ kind: 'shapes', shapeIds: ['s-1'] });
    expect([...container.querySelectorAll<HTMLInputElement>('[data-format]')].map((pill) => pill.getAttribute('aria-label')))
      .toEqual(['STEP', 'STL', 'DXF', 'SVG', 'PNG']);

    const shown = (): string[] => ['step-section', 'stl-section', 'drawing-section', 'png-section']
      .filter((ref) => !q(ref).classList.contains('hidden'));
    expect(shown()).toEqual(['step-section']);
    pickFormat('dxf');
    expect(shown()).toEqual(['drawing-section']);
    // The stroke width is the SVG's alone.
    expect(q('stroke-section').classList.contains('hidden')).toBe(true);
    pickFormat('svg');
    expect(shown()).toEqual(['drawing-section']);
    expect(q('stroke-section').classList.contains('hidden')).toBe(false);
    pickFormat('stl');
    expect(shown()).toEqual(['stl-section']);
    pickFormat('png');
    expect(shown()).toEqual(['png-section']);
  });

  it('offers the six standard views, with hidden lines and tangent edges off', () => {
    const { dialog, q, pickFormat } = mount();
    dialog.show({ kind: 'shapes', shapeIds: ['s-1'] });
    pickFormat('dxf');
    expect([...q<HTMLSelectElement>('drawing-view').options].map((o) => [o.value, o.textContent])).toEqual([
      ['top', 'Top (XY)'],
      ['bottom', 'Bottom (−XY)'],
      ['front', 'Front (XZ)'],
      ['back', 'Back (−XZ)'],
      ['right', 'Right (YZ)'],
      ['left', 'Left (−YZ)'],
    ]);
    expect(q<HTMLInputElement>('hidden-lines').checked).toBe(false);
    expect(q<HTMLInputElement>('tangent-edges').checked).toBe(false);
    expect(q('drawing-section').textContent).toContain('dashed, on their own layer');
  });

  it('sends the plane and the two edge options, and none of the STEP or STL ones', async () => {
    const { dialog, exportShapes, q, pickFormat } = mount();
    dialog.show({ kind: 'shapes', shapeIds: ['s-1', 's-2'] });
    // Options left behind by the other formats must not ride along.
    pickFormat('stl');
    q<HTMLSelectElement>('resolution').value = 'custom';
    pickFormat('dxf');
    pickView(q, 'front');
    toggle(q, 'hidden-lines');

    await clickExport(q);

    expect(exportShapes).toHaveBeenCalledWith({
      format: 'dxf',
      shapeIds: ['s-1', 's-2'],
      plane: 'front',
      hiddenLines: true,
      tangentEdges: false,
    });
    expect(deliverFileMock.mock.calls[0][1]).toBe('export-front.dxf');
    expect(deliverFileMock.mock.calls[0][2]).toEqual([{ name: 'DXF Files', extensions: ['dxf'] }]);
  });

  it('opens on the standard view the camera clearly faces, anew at every opening', () => {
    let eye = { x: 0.1, y: -0.95, z: 0.2 };
    const { dialog, q, pickFormat } = mount(null, { eyeDirection: () => eye });
    dialog.show({ kind: 'shapes', shapeIds: ['s-1'] });
    pickFormat('dxf');
    expect(viewLabel(q)).toBe('Front (XZ)');

    // A pick made while open holds until the dialog is opened again.
    pickView(q, 'left');
    expect(viewLabel(q)).toBe('Left (−YZ)');
    eye = { x: -0.2, y: 0.1, z: -5 };
    dialog.hide();
    dialog.show({ kind: 'shapes', shapeIds: ['s-1'] });
    expect(viewLabel(q)).toBe('Bottom (−XY)');
  });

  it('opens on Top without a camera to ask, and from a camera on no side in particular', () => {
    const none = mount();
    none.dialog.show({ kind: 'shapes', shapeIds: ['s-1'] });
    expect(viewLabel(none.q)).toBe('Top (XY)');

    const unknown = mount(null, { eyeDirection: () => null });
    unknown.dialog.show({ kind: 'shapes', shapeIds: ['s-1'] });
    expect(viewLabel(unknown.q)).toBe('Top (XY)');

    const iso = mount(null, lookingFrom(1, -1, 1));
    iso.dialog.show({ kind: 'shapes', shapeIds: ['s-1'] });
    expect(viewLabel(iso.q)).toBe('Top (XY)');
  });

  it('names a part scene\'s drawing <file>-<view>.dxf, whichever row is exported', async () => {
    const { dialog, exportShapes, q, pickFormat } = mount(null, lookingFrom(1, 0, 0));
    dialog.setConfigurations(PART_TABLE);
    dialog.show(partTarget);
    pickFormat('dxf');
    pickConfiguration(q, 'M8');

    await clickExport(q);

    expect(exportShapes).toHaveBeenCalledWith({
      format: 'dxf',
      shapeIds: ['s-1', 's-2'],
      plane: 'right',
      hiddenLines: false,
      tangentEdges: false,
      configuration: 'M8',
    });
    expect(deliverFileMock.mock.calls[0][1]).toBe('plate-right.dxf');
  });

  it('All configurations draws every row on the picked view: <file>-<Row>-<view>.dxf in <file>-<view>-configurations.zip', async () => {
    const { dialog, exportShapes, q, pickFormat } = mount();
    exportShapes.mockImplementation(async (body: any) => new Blob([`dxf ${body.configuration}`]));
    dialog.setConfigurations(PART_TABLE);
    dialog.show(partTarget);
    pickFormat('dxf');
    pickView(q, 'front');
    pickConfiguration(q, 'All configurations (.zip)');
    expect(q<HTMLSelectElement>('configuration').disabled).toBe(false);

    q<HTMLButtonElement>('export-btn').click();
    await waitForStatus(q, () => deliverFileMock.mock.calls.length > 0);

    expect(requestsOf(exportShapes, 'dxf')).toEqual(['Default', 'M6', 'M8'].map((configuration) => ({
      format: 'dxf', shapeIds: ['s-1', 's-2'], plane: 'front', hiddenLines: false, tangentEdges: false, configuration,
    })));
    const [archive, name] = deliverFileMock.mock.calls[0];
    expect(name).toBe('plate-front-configurations.zip');
    const zip = await JSZip.loadAsync(await archive.arrayBuffer());
    expect(Object.keys(zip.files)).toEqual(['plate-front.dxf', 'plate-M6-front.dxf', 'plate-M8-front.dxf']);
    expect(await zip.file('plate-M8-front.dxf')!.async('string')).toBe('dxf M8');
  });

  it('lets the whole assembly pick DXF or SVG, which shows a note in place of the options and disables Export', async () => {
    const { dialog, container, exportShapes, q, pickFormat } = mount(provider());
    const noteShown = (): boolean => !q('format-note').classList.contains('hidden');
    const exportBtn = q<HTMLButtonElement>('export-btn');

    dialog.show({ kind: 'assembly' });
    // Every pill is on screen and can be picked; the note waits for a drawing format.
    expect([...container.querySelectorAll<HTMLInputElement>('[data-format]')]
      .filter((p) => !p.classList.contains('hidden') && !p.disabled).map((p) => p.dataset.format)).toEqual(['step', 'stl', 'dxf', 'svg', 'png']);
    expect(noteShown()).toBe(false);
    expect(exportBtn.disabled).toBe(false);

    for (const format of ['dxf', 'svg']) {
      pickFormat(format);
      expect(noteShown()).toBe(true);
      expect(q('format-note').textContent).toBe('DXF/SVG exports are supported only on single parts');
      expect(q('drawing-section').classList.contains('hidden')).toBe(true);
      expect(exportBtn.disabled).toBe(true);
    }
    exportBtn.click();
    await Promise.resolve();
    expect(exportShapes).not.toHaveBeenCalled();
    expect(q('status').classList.contains('hidden')).toBe(true);

    // Another format takes the note away and gives Export back.
    pickFormat('stl');
    expect(noteShown()).toBe(false);
    expect(q('stl-section').classList.contains('hidden')).toBe(false);
    expect(exportBtn.disabled).toBe(false);
  });

  it('opens the whole assembly on STEP when a drawing format was left selected, and gives solids their options back', async () => {
    const { dialog, container, exportShapes, q, pickFormat } = mount(provider());
    const pill = (format: string): HTMLInputElement => container.querySelector<HTMLInputElement>(`[data-format="${format}"]`)!;

    dialog.show({ kind: 'shapes', shapeIds: ['s-1'] });
    pickFormat('svg');
    expect(q('format-note').classList.contains('hidden')).toBe(true);
    expect(q('drawing-section').classList.contains('hidden')).toBe(false);
    dialog.hide();

    dialog.show({ kind: 'assembly' });
    expect(pill('step').checked).toBe(true);
    expect(q('format-note').classList.contains('hidden')).toBe(true);
    expect(q('drawing-section').classList.contains('hidden')).toBe(true);
    expect(q('step-section').classList.contains('hidden')).toBe(false);

    await clickExport(q);
    expect((exportShapes.mock.calls[0][0] as any).format).toBe('step');
    expect(deliverFileMock.mock.calls[0][1]).toBe('robot.step');

    // A drawing format picked on the assembly is a drawing again on solids.
    dialog.show({ kind: 'assembly' });
    pickFormat('dxf');
    dialog.hide();
    dialog.show({ kind: 'shapes', shapeIds: ['s-1'] });
    expect(pill('dxf').checked).toBe(true);
    expect(q('format-note').classList.contains('hidden')).toBe(true);
    expect(q('drawing-section').classList.contains('hidden')).toBe(false);
    expect(q<HTMLButtonElement>('export-btn').disabled).toBe(false);
  });

  it('SVG sends the drawing options and its stroke width, and downloads <base>-<view>.svg', async () => {
    const { dialog, exportShapes, q, pickFormat } = mount();
    dialog.show({ kind: 'shapes', shapeIds: ['s-1'] });
    pickFormat('svg');
    const stroke = q<HTMLInputElement>('stroke-width');
    expect([stroke.value, stroke.min, stroke.step]).toEqual(['0.25', '0.01', '0.05']);
    expect(q('stroke-section').textContent).toContain('Stroke width (mm)');
    pickView(q, 'right');
    toggle(q, 'tangent-edges');
    stroke.value = '0.5';

    await clickExport(q);

    expect(requestsOf(exportShapes, 'svg')).toContainEqual({
      format: 'svg',
      shapeIds: ['s-1'],
      plane: 'right',
      hiddenLines: false,
      tangentEdges: true,
      strokeWidth: 0.5,
    });
    expect(deliverFileMock.mock.calls[0][1]).toBe('export-right.svg');
    expect(deliverFileMock.mock.calls[0][2]).toEqual([{ name: 'SVG Images', extensions: ['svg'] }]);
  });

  it('leaves a stroke width that is no width to the server, and never sends one with a DXF', async () => {
    const svg = mount();
    svg.dialog.show({ kind: 'shapes', shapeIds: ['s-1'] });
    svg.pickFormat('svg');
    svg.q<HTMLInputElement>('stroke-width').value = '';
    await clickExport(svg.q);
    expect(deliverFileMock.mock.calls[0][1]).toBe('export-top.svg');
    // Preview and export alike: no body of this run carries a stroke width.
    expect(requestsOf(svg.exportShapes, 'svg').length).toBeGreaterThan(0);
    for (const body of requestsOf(svg.exportShapes, 'svg')) {
      expect(body).toEqual({ format: 'svg', shapeIds: ['s-1'], plane: 'top', hiddenLines: false, tangentEdges: false });
    }

    deliverFileMock.mockClear();
    const zero = mount();
    zero.dialog.show({ kind: 'shapes', shapeIds: ['s-1'] });
    zero.pickFormat('svg');
    zero.q<HTMLInputElement>('stroke-width').value = '0';
    await clickExport(zero.q);
    expect(requestsOf(zero.exportShapes, 'svg').every((body) => !('strokeWidth' in body))).toBe(true);

    deliverFileMock.mockClear();
    const dxf = mount();
    dxf.dialog.show({ kind: 'shapes', shapeIds: ['s-1'] });
    dxf.pickFormat('svg');
    dxf.q<HTMLInputElement>('stroke-width').value = '0.7';
    dxf.pickFormat('dxf');
    await clickExport(dxf.q);
    expect(requestsOf(dxf.exportShapes, 'dxf')).toEqual([
      { format: 'dxf', shapeIds: ['s-1'], plane: 'top', hiddenLines: false, tangentEdges: false },
    ]);
  });

  it('names a part scene\'s SVGs as its DXFs: <file>-<view>.svg, <file>-<Row>-<view>.svg in <file>-<view>-configurations.zip', async () => {
    const one = mount();
    one.dialog.setConfigurations(PART_TABLE);
    one.dialog.show(partTarget);
    one.pickFormat('svg');
    pickView(one.q, 'front');
    pickConfiguration(one.q, 'M8');
    await clickExport(one.q);
    expect(one.exportShapes).toHaveBeenCalledWith({
      format: 'svg', shapeIds: ['s-1', 's-2'], plane: 'front', hiddenLines: false, tangentEdges: false, strokeWidth: 0.25, configuration: 'M8',
    });
    expect(deliverFileMock.mock.calls[0][1]).toBe('plate-front.svg');

    deliverFileMock.mockClear();
    const { dialog, exportShapes, q, pickFormat } = mount();
    exportShapes.mockImplementation(async (body: any) => new Blob([`svg ${body.configuration}`]));
    dialog.setConfigurations(PART_TABLE);
    dialog.show(partTarget);
    pickFormat('svg');
    pickView(q, 'front');
    pickConfiguration(q, 'All configurations (.zip)');

    q<HTMLButtonElement>('export-btn').click();
    await waitForStatus(q, () => deliverFileMock.mock.calls.length > 0);

    // The rows of the run carry their configuration; the preview of the row on screen does not.
    expect(requestsOf(exportShapes, 'svg').filter((body) => body.configuration !== undefined)).toEqual(
      ['Default', 'M6', 'M8'].map((configuration) => ({
        format: 'svg', shapeIds: ['s-1', 's-2'], plane: 'front', hiddenLines: false, tangentEdges: false, strokeWidth: 0.25, configuration,
      })),
    );
    const [archive, name] = deliverFileMock.mock.calls[0];
    expect(name).toBe('plate-front-configurations.zip');
    const zip = await JSZip.loadAsync(await archive.arrayBuffer());
    expect(Object.keys(zip.files)).toEqual(['plate-front.svg', 'plate-M6-front.svg', 'plate-M8-front.svg']);
    expect(await zip.file('plate-M6-front.svg')!.async('string')).toBe('svg M6');
  });

  it('delivers a file the server warned about and stays open on what it said', async () => {
    const { dialog, container, exportShapes, q, pickFormat } = mount();
    exportShapes.mockResolvedValue({
      blob: new Blob(['dxf']),
      warnings: ['2 curves were approximated by polylines: the kernel could not hand them over as splines.'],
    });
    dialog.show({ kind: 'shapes', shapeIds: ['s-1'] });
    pickFormat('dxf');

    q<HTMLButtonElement>('export-btn').click();
    await waitForStatus(q, () => deliverFileMock.mock.calls.length > 0 && !q('status').textContent?.includes('Exporting'));

    expect(deliverFileMock.mock.calls[0][1]).toBe('export-top.dxf');
    const overlay = container.firstElementChild!;
    expect(overlay.classList.contains('hidden')).toBe(false);
    expect(q('status').classList.contains('hidden')).toBe(false);
    expect(q('status').textContent).toContain('2 curves were approximated by polylines');
    expect(q<HTMLButtonElement>('export-btn').disabled).toBe(false);
  });

  it('closes after a drawing the server had nothing to say about', async () => {
    const { dialog, container, exportShapes, q, pickFormat } = mount();
    exportShapes.mockResolvedValue({ blob: new Blob(['dxf']), warnings: [] });
    dialog.show({ kind: 'shapes', shapeIds: ['s-1'] });
    pickFormat('dxf');

    await clickExport(q);
    await vi.waitFor(() => {
      if (!container.firstElementChild!.classList.contains('hidden')) {
        throw new Error('still open');
      }
    });
  });

  it('names each row\'s warnings in an All configurations run', async () => {
    const { dialog, exportShapes, q, pickFormat } = mount();
    exportShapes.mockImplementation(async (body: any) => ({
      blob: new Blob(['dxf']),
      warnings: body.configuration === 'M8' ? ['1 curve was approximated by polylines.'] : [],
    }));
    dialog.setConfigurations(PART_TABLE);
    dialog.show(partTarget);
    pickFormat('dxf');
    pickConfiguration(q, 'All configurations (.zip)');

    q<HTMLButtonElement>('export-btn').click();
    await waitForStatus(q, () => deliverFileMock.mock.calls.length > 0 && !q('status').textContent?.includes('Packing'));

    expect(q('status').textContent).toContain('M8: 1 curve was approximated by polylines.');
    expect(q('status').textContent).not.toContain('M6:');
  });
});

// The drawing section previews what its options export: the SVG of the same
// request (a DXF's too), asked for once the options have rested, shown in an
// <img> through an object URL. An answer overtaken by a newer question or by
// the dialog closing is dropped, every URL is let go, and a preview that
// cannot be had never stands in the way of the export.
describe('ExportDialog drawing preview', () => {
  const SVG = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g id="visible"><path d="M0 0L10 10"/></g></svg>';
  const PART_TABLE = {
    active: 'Default',
    names: ['M6', 'M8'],
    rows: { M6: { Hole: 6 }, M8: { Hole: 8 } },
  };
  const partTarget = { kind: 'shapes' as const, shapeIds: ['s-1', 's-2'], fileBase: 'plate' };
  const PREVIEW = { format: 'svg', shapeIds: ['s-1'], plane: 'top', hiddenLines: false, tangentEdges: false };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  function open(target: Parameters<ExportDialog['show']>[0] = { kind: 'shapes', shapeIds: ['s-1'] }) {
    const opened = mount();
    opened.exportShapes.mockImplementation(async () => new Blob([SVG], { type: 'image/svg+xml' }));
    opened.dialog.show(target);
    const image = (): HTMLImageElement => opened.q<HTMLImageElement>('drawing-preview-image');
    const status = (): HTMLElement => opened.q('drawing-preview-status');
    const change = (ref: string, value?: string): void => {
      const control = opened.q<HTMLInputElement | HTMLSelectElement>(ref);
      if (value === undefined) {
        (control as HTMLInputElement).checked = !(control as HTMLInputElement).checked;
      } else {
        control.value = value;
      }
      control.dispatchEvent(new Event('change'));
    };
    return { ...opened, image, status, change };
  }

  /** Let the debounce run out and the answer land. */
  async function rest(): Promise<void> {
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    // The answer's text is read off the timer queue.
    for (let turn = 0; turn < 20; turn++) {
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(0);
  }

  it('asks for the SVG of the options once they have rested, and shows it in the image', async () => {
    const { exportShapes, pickFormat, image, status } = open();
    expect(exportShapes).not.toHaveBeenCalled();
    pickFormat('dxf');
    expect(status().textContent).toBe('Loading preview…');
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS - 1);
    expect(exportShapes).not.toHaveBeenCalled();

    await rest();

    expect(exportShapes.mock.calls.map((call) => call[0])).toEqual([PREVIEW]);
    expect(image().getAttribute('src')).toBe('blob:preview-1');
    expect(image().classList.contains('hidden')).toBe(false);
    expect(status().classList.contains('hidden')).toBe(true);
    // The drawing is shown as a file, on a white panel: its markup never enters the page.
    expect(image().tagName).toBe('IMG');
    expect(image().parentElement!.querySelector('svg')).toBeNull();
    expect(image().parentElement!.classList.contains('bg-white')).toBe(true);
  });

  it('opens straight on the preview when a drawing format was left selected', async () => {
    const { dialog, exportShapes, pickFormat } = open();
    pickFormat('svg');
    await rest();
    dialog.hide();
    exportShapes.mockClear();

    dialog.show({ kind: 'shapes', shapeIds: ['s-9'] });
    await rest();

    expect(exportShapes.mock.calls.map((call) => call[0])).toEqual([{ ...PREVIEW, shapeIds: ['s-9'] }]);
  });

  it('asks again for each change of what the drawing shows, once per rest', async () => {
    const { exportShapes, pickFormat, change } = open();
    pickFormat('dxf');
    await rest();
    exportShapes.mockClear();

    change('drawing-view', 'front');
    await rest();
    change('hidden-lines');
    await rest();
    change('tangent-edges');
    await rest();
    expect(exportShapes.mock.calls.map((call) => call[0])).toEqual([
      { ...PREVIEW, plane: 'front' },
      { ...PREVIEW, plane: 'front', hiddenLines: true },
      { ...PREVIEW, plane: 'front', hiddenLines: true, tangentEdges: true },
    ]);

    // Changes in quick succession are one question: the last.
    exportShapes.mockClear();
    change('drawing-view', 'left');
    await vi.advanceTimersByTimeAsync(100);
    change('drawing-view', 'back');
    await vi.advanceTimersByTimeAsync(100);
    change('hidden-lines');
    await rest();
    expect(exportShapes.mock.calls.map((call) => call[0])).toEqual([
      { ...PREVIEW, plane: 'back', hiddenLines: false, tangentEdges: true },
    ]);
  });

  it('is the same drawing for DXF and SVG, whatever the stroke width: neither asks again', async () => {
    const { exportShapes, pickFormat, q, image } = open();
    pickFormat('dxf');
    await rest();
    expect(exportShapes).toHaveBeenCalledTimes(1);

    pickFormat('svg');
    const stroke = q<HTMLInputElement>('stroke-width');
    stroke.value = '1.5';
    stroke.dispatchEvent(new Event('change'));
    stroke.dispatchEvent(new Event('input'));
    await rest();

    expect(exportShapes).toHaveBeenCalledTimes(1);
    expect('strokeWidth' in (exportShapes.mock.calls[0][0] as object)).toBe(false);
    expect(image().getAttribute('src')).toBe('blob:preview-1');
  });

  it('asks nothing for STEP, STL or PNG, and a move to one of them stops a preview not yet asked for', async () => {
    const { exportShapes, pickFormat, q } = open();
    await rest();
    pickFormat('stl');
    await rest();
    pickFormat('png');
    await rest();
    expect(exportShapes).not.toHaveBeenCalled();

    pickFormat('dxf');
    await vi.advanceTimersByTimeAsync(100);
    pickFormat('step');
    expect(q('drawing-section').classList.contains('hidden')).toBe(true);
    await rest();
    expect(exportShapes).not.toHaveBeenCalled();

    // Back on a drawing, the preview that never went out goes out.
    pickFormat('svg');
    await rest();
    expect(exportShapes.mock.calls.map((call) => call[0])).toEqual([PREVIEW]);

    // ...and once shown, leaving and coming back to the same options asks nothing more.
    pickFormat('step');
    pickFormat('dxf');
    await rest();
    expect(exportShapes).toHaveBeenCalledTimes(1);
  });

  it('asks nothing for the whole assembly', async () => {
    const whole = mount(provider());
    whole.dialog.show({ kind: 'shapes', shapeIds: ['s-1'] });
    whole.pickFormat('dxf');
    whole.dialog.hide();
    whole.dialog.show({ kind: 'assembly' });
    await rest();
    expect(whole.exportShapes).not.toHaveBeenCalled();
  });

  it('previews the picked configuration row, and the row on screen for All configurations, saying so', async () => {
    const { dialog, exportShapes, pickFormat, q } = open(partTarget);
    dialog.setConfigurations(PART_TABLE);
    pickFormat('dxf');
    await rest();
    pickConfiguration(q, 'M8');
    await rest();
    expect(q('drawing-preview-note').classList.contains('hidden')).toBe(true);
    pickConfiguration(q, 'All configurations (.zip)');
    await rest();

    const base = { ...PREVIEW, shapeIds: ['s-1', 's-2'] };
    expect(exportShapes.mock.calls.map((call) => call[0])).toEqual([
      { ...base, configuration: 'Default' },
      { ...base, configuration: 'M8' },
      base,
    ]);
    expect(q('drawing-preview-note').classList.contains('hidden')).toBe(false);
    expect(q('drawing-preview-note').textContent).toBe('The preview shows the configuration on screen.');
  });

  it('asks again when a render lands while it is open: the scene it drew is gone', async () => {
    const { dialog, exportShapes, pickFormat } = open(partTarget);
    pickFormat('dxf');
    await rest();
    expect(exportShapes).toHaveBeenCalledTimes(1);

    dialog.setConfigurations(null);
    await rest();
    expect(exportShapes).toHaveBeenCalledTimes(2);
    expect(exportShapes.mock.calls[1][0]).toEqual(exportShapes.mock.calls[0][0]);

    // A render while the dialog is closed asks nothing.
    dialog.hide();
    dialog.setConfigurations(null);
    await rest();
    expect(exportShapes).toHaveBeenCalledTimes(2);
  });

  it('drops an answer a newer question overtook', async () => {
    const { exportShapes, pickFormat, change, image } = open();
    const answers: Record<string, (blob: Blob) => void> = {};
    exportShapes.mockImplementation((body: any) => new Promise<Blob>((resolve) => {
      answers[body.plane] = resolve;
    }));
    pickFormat('dxf');
    await rest();
    change('drawing-view', 'front');
    await rest();
    expect(Object.keys(answers)).toEqual(['top', 'front']);

    // The newer answer lands first, then the older one.
    answers.front(new Blob([SVG.replace('M0 0', 'M5 5')], { type: 'image/svg+xml' }));
    await rest();
    answers.top(new Blob([SVG], { type: 'image/svg+xml' }));
    await rest();

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(image().getAttribute('src')).toBe('blob:preview-1');
    expect(await previewBlobs.get('blob:preview-1')!.text()).toContain('M5 5');
  });

  it('drops an answer that lands after the dialog closed', async () => {
    const { dialog, exportShapes, pickFormat, image } = open();
    let answer!: (blob: Blob) => void;
    exportShapes.mockImplementation(() => new Promise<Blob>((resolve) => {
      answer = resolve;
    }));
    pickFormat('dxf');
    await rest();
    dialog.hide();
    answer(new Blob([SVG], { type: 'image/svg+xml' }));
    await rest();

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(image().getAttribute('src')).toBeNull();
  });

  it('lets go of each object URL when the next drawing replaces it and when the dialog closes', async () => {
    const { dialog, pickFormat, change, image } = open();
    pickFormat('dxf');
    await rest();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    change('hidden-lines');
    // The drawing on screen stays, dimmed, until the next one is in.
    expect(image().getAttribute('src')).toBe('blob:preview-1');
    expect(image().classList.contains('opacity-40')).toBe(true);
    await rest();
    expect(image().getAttribute('src')).toBe('blob:preview-2');
    expect(image().classList.contains('opacity-40')).toBe(false);
    expect(revokeObjectURL.mock.calls.map((call) => call[0])).toEqual(['blob:preview-1']);

    dialog.hide();
    expect(revokeObjectURL.mock.calls.map((call) => call[0])).toEqual(['blob:preview-1', 'blob:preview-2']);
    expect(image().getAttribute('src')).toBeNull();
    expect(image().classList.contains('hidden')).toBe(true);
  });

  it('draws the preview\'s lines for the screen, leaving the file\'s own markup as it came', async () => {
    const { pickFormat } = open();
    pickFormat('svg');
    await rest();

    const shown = previewBlobs.get('blob:preview-1')!;
    expect(shown.type).toBe('image/svg+xml');
    const text = await shown.text();
    const [head, tail] = text.split('<style>');
    expect(head).toBe('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">');
    expect(tail).toContain('non-scaling-stroke');
    expect(tail.endsWith('</style><g id="visible"><path d="M0 0L10 10"/></g></svg>')).toBe(true);
  });

  it('says in one line why there is no preview, and exports all the same', async () => {
    const { exportShapes, pickFormat, q, image, status, container } = open();
    exportShapes.mockImplementation(async (body: any) => {
      if (body.format === 'svg') {
        throw new Error('Invalid format. Must be "step", "stl" or "dxf".');
      }
      return new Blob(['dxf']);
    });
    pickFormat('dxf');
    await rest();

    expect(status().textContent).toBe('Preview unavailable: Invalid format. Must be "step", "stl" or "dxf".');
    expect(status().classList.contains('hidden')).toBe(false);
    expect(status().classList.contains('truncate')).toBe(true);
    expect(image().classList.contains('hidden')).toBe(true);
    // Not an export error: the dialog's own status line is untouched, the button live.
    expect(q('status').classList.contains('hidden')).toBe(true);
    expect(q<HTMLButtonElement>('export-btn').disabled).toBe(false);

    q<HTMLButtonElement>('export-btn').click();
    await rest();
    expect(deliverFileMock.mock.calls[0][1]).toBe('export-top.dxf');
    expect(container.firstElementChild!.classList.contains('hidden')).toBe(true);
  });

  it('keeps a preview\'s warnings to itself: they are the export\'s to report', async () => {
    const { exportShapes, pickFormat, q } = open();
    exportShapes.mockImplementation(async () => ({
      blob: new Blob([SVG], { type: 'image/svg+xml' }),
      warnings: ['1 curve was approximated by polylines.'],
    }));
    pickFormat('dxf');
    await rest();

    expect(q('status').classList.contains('hidden')).toBe(true);
    expect(q('drawing-section').textContent).not.toContain('approximated');
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
