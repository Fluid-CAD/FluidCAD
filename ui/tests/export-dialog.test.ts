// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportDialog, exportBaseName, type ExportAssemblyProvider } from '../src/ui/export-dialog';
import type { EngineClient } from '../src/engine-client';
import type { SceneContext } from '../src/scene/scene-context';
import type { MeasurePose } from '../src/api';

// The export dialog's two targets. Shapes: the listed solids, as before.
// Assembly: the whole assembly where its parts sit — the body carries one
// live pose per instance (the browser solver owns them, the server only knows
// the statement pose), the download is named after the assembly file, and an
// instance the solver has not placed yet stops the export before any request.

vi.mock('../src/desktop', () => ({
  deliverFile: vi.fn(async () => 'downloaded'),
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

describe('exportBaseName', () => {
  it('strips the directory and the assembly / js suffix', () => {
    expect(exportBaseName('/work/robot.assembly.js')).toBe('robot');
    expect(exportBaseName('C:\\work\\arm.assembly.js')).toBe('arm');
    expect(exportBaseName('/work/bracket.js')).toBe('bracket');
    expect(exportBaseName('')).toBe('');
  });
});
