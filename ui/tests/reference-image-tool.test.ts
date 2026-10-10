// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scene } from 'three';
import { ReferenceImageTool } from '../src/interactive/tools/reference-image-tool';
import { ReferenceImagePanel } from '../src/interactive/tools/reference-image-panel';
import { ReferenceImageHandles } from '../src/interactive/tools/reference-image-handles';
import { DimensionInput } from '../src/ui/dimension-input';
import type { LoadedImage } from '../src/scene/reference-image-loader';
import type { PlaneData } from '../src/types';

// The Image tool's flows, driven against its panel and a stubbed scene:
// direct manipulation in the viewport (move, corner resize, rotate), the
// two-click calibration, a chosen file uploaded beside the model and the
// chain written with the relative path, Remove writing null, Cancel
// dropping the preview, a refused commit staying open with the reason.

const XY: PlaneData = {
  origin: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 }, xDirection: { x: 1, y: 0, z: 0 }, yDirection: { x: 0, y: 1, z: 0 },
};
const LOC = { filePath: '/ws/parts/bracket.part.js', line: 7, column: 1 };
const SEED = { src: 'images/a.png', width: 80, at: [0, 0] as [number, number], angle: 0, opacity: 0.5 };
const PIXEL = { width: 400, height: 200 };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const image = (w: number, h: number): LoadedImage => ({ source: {} as any, width: w, height: h, close: vi.fn() });

/** One sketch unit per client pixel, the sketch origin at client (500, 500), y up. */
const toSketch = (clientX: number, clientY: number): [number, number] => [clientX - 500, 500 - clientY];
const toClient = (p: [number, number]) => ({ clientX: p[0] + 500, clientY: 500 - p[1] });

function makeTool(opts: { current?: { spec: any; pixel: any } | null; commitResult?: { success: boolean; reason?: string } } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const scene = new Scene();
  const host = {
    current: vi.fn(() => opts.current ?? null),
    preview: vi.fn(),
    clearPreview: vi.fn(),
  };
  const upload = vi.fn(async (path: string, _data: string) => ({ path: 'parts/images/pic.png', absPath: path.replace(/\/images\/.*$/, '/images/pic.png'), size: 3 }));
  const commit = vi.fn(async () => opts.commitResult ?? { success: true });
  const decode = vi.fn(async () => image(PIXEL.width, PIXEL.height));
  const onRequestExit = vi.fn();
  const cameraControls = { enabled: true };
  const tool: any = Object.create(ReferenceImageTool.prototype);
  tool.plane = XY;
  tool.canvas = document.createElement('canvas');
  tool.canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000, right: 1000, bottom: 1000, x: 0, y: 0, toJSON() {} });
  tool.ctx = { scene, cameraControls, requestRender: vi.fn(), subscribeCameraChange: vi.fn(() => () => {}) };
  tool.host = host;
  tool.sourceLocation = LOC;
  tool.onRequestExit = onRequestExit;
  tool.upload = upload;
  tool.commit = commit;
  tool.decode = decode;
  tool.spec = null;
  tool.pixel = null;
  tool.chosen = null;
  tool.pending = null;
  tool.drag = null;
  tool.hover = null;
  tool.calibrate = { state: 'idle', points: [] };
  tool.busy = false;
  tool.unsubscribeCamera = null;
  tool.boundPointerDown = tool.handlePointerDown.bind(tool);
  tool.boundPointerMove = tool.handlePointerMove.bind(tool);
  tool.boundPointerUp = tool.handlePointerUp.bind(tool);
  tool.panel = new ReferenceImagePanel(container);
  tool.panel.onOpacity = (opacity: number) => tool.setSpec(tool.spec ? { ...tool.spec, opacity } : null);
  tool.panel.onCalibrate = () => tool.toggleCalibrate();
  tool.panel.onApply = () => void tool.apply();
  tool.panel.onRemove = () => void tool.remove();
  tool.panel.onExit = () => tool.cancel();
  tool.panel.onFile = (file: File) => void tool.chooseFile(file);
  tool.handles = new ReferenceImageHandles(XY);
  tool.distanceInput = new DimensionInput(container);
  // The scene stubs: screen → sketch is 1:1 about (500, 500); snapping is identity.
  tool.snapAt = vi.fn((x: number, y: number) => toSketch(x, y));
  tool.tolerances = () => ({ corner: 8, rotate: 12, stem: 28 });
  tool.stem = () => 28;
  tool.midpointClient = (mid: [number, number]) => toClient(mid);
  const root = container.querySelector<HTMLElement>('#fluidcad-reference-image-panel')!;
  const field = (role: string) => root.querySelector<HTMLInputElement>(`[data-role="${role}"]`)!;
  const message = () => root.querySelector<HTMLElement>('[data-role="message"]')!;
  const press = (p: [number, number], init: PointerEventInit = {}) => {
    tool.canvas.dispatchEvent(new PointerEvent('pointerdown', { ...toClient(p), button: 0, bubbles: true, ...init }));
  };
  const moveTo = (p: [number, number], init: PointerEventInit = {}) => {
    window.dispatchEvent(new PointerEvent('pointermove', { ...toClient(p), bubbles: true, ...init }));
  };
  const release = (p: [number, number]) => {
    window.dispatchEvent(new PointerEvent('pointerup', { ...toClient(p), button: 0, bubbles: true }));
  };
  const lastPreview = () => host.preview.mock.calls[host.preview.mock.calls.length - 1][1];
  return { tool, host, scene, upload, commit, decode, onRequestExit, cameraControls, field, message, press, moveTo, release, lastPreview };
}

vi.mock('../src/interactive/sketch-plane-utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/interactive/sketch-plane-utils')>();
  return {
    ...original,
    projectToSketch: (_ctx: unknown, _plane: unknown, clientX: number, clientY: number) => [clientX - 500, 500 - clientY],
    pixelToSketchThreshold: (_ctx: unknown, px: number) => px,
    sketchToClient: (_ctx: unknown, _plane: unknown, p: [number, number]) => ({ clientX: p[0] + 500, clientY: 500 - p[1] }),
  };
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ReferenceImageTool path helpers', () => {
  it('makes a file name path-safe', () => {
    expect(ReferenceImageTool.safeName('My Side View (1).PNG')).toBe('My-Side-View-1-.PNG');
    expect(ReferenceImageTool.safeName('../../etc/passwd')).toBe('passwd');
    expect(ReferenceImageTool.safeName('C:\\pics\\side.png')).toBe('side.png');
    expect(ReferenceImageTool.safeName('***')).toBe('image');
  });

  it('writes the uploaded path relative to the model file folder', () => {
    expect(ReferenceImageTool.relativeSrc('/ws/parts/bracket.part.js', '/ws/parts/images/side-2.png')).toBe('images/side-2.png');
    expect(ReferenceImageTool.relativeSrc('/ws/parts/bracket.part.js', '/ws/other/side.png')).toBe('/ws/other/side.png');
    expect(ReferenceImageTool.relativeSrc('C:\\ws\\bracket.part.js', 'C:\\ws\\images\\a.png')).toBe('images/a.png');
  });

  it('rounds the written record to three decimals', () => {
    expect(ReferenceImageTool.editOf({ src: 'a.png', width: 80.12345, at: [1.00004, -2.5], angle: 10.0004, opacity: 0.33333 }))
      .toEqual({ src: 'a.png', width: 80.123, at: [1, -2.5], angle: 10, opacity: 0.333 });
  });
});

describe('ReferenceImageTool', () => {
  it('opens seeded from the sketch record: preview, handles, read-out and Remove', () => {
    const { tool, host, scene, field } = makeTool({ current: { spec: SEED, pixel: PIXEL } });
    tool.onActivate();
    expect(host.preview).toHaveBeenLastCalledWith(XY, SEED, null);
    expect(field('readout').textContent).toBe('80.00 × 40.00 mm at 0.00, 0.00');
    expect(field('remove').classList.contains('hidden')).toBe(false);
    expect(scene.children).toContain(tool.handles.group);
    expect(tool.handles.group.children.length).toBeGreaterThan(0);
  });

  it('opens empty without a record and draws no handles until a file is chosen', async () => {
    const { tool, host, decode } = makeTool();
    tool.onActivate();
    expect(host.preview).not.toHaveBeenCalled();
    expect(tool.handles.group.children.length).toBe(0);
    await tool.chooseFile(new File([new Uint8Array([1, 2, 3])], 'Side View.png', { type: 'image/png' }));
    expect(decode).toHaveBeenCalled();
    // Half the visible width (1000 px = 1000 units), centred on the view.
    expect(host.preview).toHaveBeenLastCalledWith(XY, { src: '', width: 500, at: [0, 0], angle: 0, opacity: 0.5 }, expect.objectContaining({ width: 400 }));
    expect(tool.handles.group.children.length).toBeGreaterThan(0);
  });

  it('drags the body to move it, taking the camera while the press lasts', () => {
    const { tool, cameraControls, press, moveTo, release, lastPreview } = makeTool({ current: { spec: SEED, pixel: PIXEL } });
    tool.onActivate();
    press([10, 5]);
    expect(cameraControls.enabled).toBe(false);
    moveTo([11, 5]);                      // under the drag threshold: still a click
    expect(lastPreview().at).toEqual([0, 0]);
    moveTo([30, -5]);
    expect(lastPreview().at).toEqual([20, -10]);
    expect(tool.canvas.style.cursor).toBe('move');
    release([30, -5]);
    expect(cameraControls.enabled).toBe(true);
    expect(tool.drag).toBeNull();
  });

  it('drags a corner to resize about the opposite corner, Shift stretching', () => {
    const { tool, press, moveTo, release, lastPreview } = makeTool({ current: { spec: SEED, pixel: PIXEL } });
    tool.onActivate();
    press([40, 20]);                      // the top-right corner
    moveTo([60, 30]);                     // out along the diagonal
    expect(lastPreview().width).toBeCloseTo(100);
    expect(lastPreview().height).toBeUndefined();
    expect(lastPreview().at[0]).toBeCloseTo(10);
    moveTo([60, 0], { shiftKey: true });
    expect(lastPreview().width).toBeCloseTo(100);
    expect(lastPreview().height).toBeCloseTo(20);
    release([60, 0]);
  });

  it('drags the knob to rotate, Shift snapping to 15°', () => {
    const { tool, press, moveTo, release, lastPreview } = makeTool({ current: { spec: SEED, pixel: PIXEL } });
    tool.onActivate();
    press([0, 48]);                       // the knob: 28 above the top edge at 20
    moveTo([-10, 0]);
    expect(lastPreview().angle).toBe(90);
    moveTo([10, 9], { shiftKey: true });
    expect(lastPreview().angle).toBe(-45);
    release([10, 9]);
    expect(tool.canvas.style.cursor).not.toBe('grabbing');
  });

  it('a press off the picture is the camera\'s, and hover sets the cursor', () => {
    const { tool, cameraControls, press, moveTo } = makeTool({ current: { spec: SEED, pixel: PIXEL } });
    tool.onActivate();
    press([200, 200]);
    expect(cameraControls.enabled).toBe(true);
    expect(tool.pending).toBeNull();
    moveTo([0, 0]);
    expect(tool.canvas.style.cursor).toBe('move');
    moveTo([40, -20]);
    expect(tool.canvas.style.cursor).toBe('nwse-resize');
    moveTo([200, 200]);
    expect(tool.canvas.style.cursor).toBe('default');
  });

  it('calibrates from two clicks and a typed distance, scaling about the centre', () => {
    const { tool, field, press, lastPreview } = makeTool({ current: { spec: SEED, pixel: PIXEL } });
    tool.onActivate();
    field('calibrate').click();
    expect(tool.calibrate.state).toBe('first');
    expect(tool.canvas.style.cursor).toBe('crosshair');
    press([-10, 0]);
    expect(tool.calibrate.state).toBe('second');
    press([10, 0]);
    expect(tool.calibrate.state).toBe('distance');
    expect(tool.distanceInput.isVisible).toBe(true);
    const input = document.querySelector<HTMLInputElement>('.dimension-input')!;
    expect(input.value).toBe('20');
    input.value = '50';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(lastPreview().width).toBeCloseTo(200);
    expect(lastPreview().at).toEqual([0, 0]);
    expect(tool.calibrate.state).toBe('idle');
    expect(tool.distanceInput.isVisible).toBe(false);
    expect(field('readout').textContent).toBe('200.00 × 100.00 mm at 0.00, 0.00');
  });

  it('Escape folds a calibration or a drag before it would leave the tool', () => {
    const { tool, field, press } = makeTool({ current: { spec: SEED, pixel: PIXEL } });
    tool.onActivate();
    expect(tool.handleEscape()).toBe(false);
    field('calibrate').click();
    press([-10, 0]);
    expect(tool.handleEscape()).toBe(true);
    expect(tool.calibrate).toEqual({ state: 'idle', points: [] });
    press([0, 0]);
    expect(tool.handleEscape()).toBe(true);
    expect(tool.pending).toBeNull();
    expect(tool.handleEscape()).toBe(false);
  });

  it('uploads a chosen file beside the model and writes the chain with the relative path', async () => {
    const { tool, host, upload, commit, onRequestExit, field } = makeTool();
    tool.onActivate();
    await tool.chooseFile(new File([new Uint8Array([1, 2, 3])], 'Side View.png', { type: 'image/png' }));
    expect(field('file-label').textContent).toBe('Side View.png · 400×200 px');
    field('opacity').value = '30';
    field('opacity').dispatchEvent(new Event('input', { bubbles: true }));
    field('apply').click();
    await flush();
    await flush();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][0]).toBe('/ws/parts/images/Side-View.png');
    expect(upload.mock.calls[0][1]).toBe('AQID');
    expect(commit).toHaveBeenCalledWith(LOC, { src: 'images/pic.png', width: 500, at: [0, 0], angle: 0, opacity: 0.3 });
    expect(host.clearPreview).toHaveBeenCalled();
    expect(onRequestExit).toHaveBeenCalledTimes(1);
  });

  it('refuses a non-image or oversized file with a message and keeps the dialog', async () => {
    const { tool, decode, message } = makeTool();
    tool.onActivate();
    await tool.chooseFile(new File(['x'], 'notes.txt', { type: 'text/plain' }));
    expect(message().textContent).toBe('Choose a PNG, JPEG, WebP, GIF or BMP image.');
    const big = new File([new Uint8Array(8)], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
    await tool.chooseFile(big);
    expect(message().textContent).toMatch(/21\.0 MB; the limit is 20 MB/);
    expect(decode).not.toHaveBeenCalled();
  });

  it('Apply on an existing record without a new file commits the record as the gestures left it', async () => {
    const { tool, upload, commit, field, press, moveTo, release } = makeTool({ current: { spec: SEED, pixel: PIXEL } });
    tool.onActivate();
    press([0, 0]);
    moveTo([5, 2]);
    release([5, 2]);
    field('apply').click();
    await flush();
    expect(upload).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledWith(LOC, { src: 'images/a.png', width: 80, at: [5, 2], angle: 0, opacity: 0.5 });
  });

  it('a refused commit keeps the dialog open with the reason', async () => {
    const { tool, onRequestExit, host, field, message } = makeTool({
      current: { spec: SEED, pixel: null },
      commitResult: { success: false, reason: 'No live code buffer' },
    });
    tool.onActivate();
    field('apply').click();
    await flush();
    expect(message().textContent).toBe('No live code buffer');
    expect(onRequestExit).not.toHaveBeenCalled();
    expect(host.clearPreview).not.toHaveBeenCalled();
    expect(field('apply').disabled).toBe(false);
  });

  it('Remove writes null; Cancel drops the preview and exits through the toolbar', async () => {
    const { tool, commit, host, onRequestExit, field } = makeTool({ current: { spec: SEED, pixel: null } });
    tool.onActivate();
    field('remove').click();
    await flush();
    expect(commit).toHaveBeenCalledWith(LOC, null);
    expect(host.clearPreview).toHaveBeenCalledTimes(1);
    expect(onRequestExit).toHaveBeenCalledTimes(1);
    field('exit').click();
    expect(host.clearPreview).toHaveBeenCalledTimes(2);
    expect(onRequestExit).toHaveBeenCalledTimes(2);
  });

  it('deactivating frees the chosen picture, the handles and the preview', async () => {
    const { tool, host, scene } = makeTool();
    tool.onActivate();
    await tool.chooseFile(new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }));
    const chosen = tool.chosen.image;
    tool.onDeactivate();
    expect(chosen.close).toHaveBeenCalled();
    expect(host.clearPreview).toHaveBeenCalled();
    expect(scene.children).not.toContain(tool.handles.group);
    expect(document.querySelector('#fluidcad-reference-image-panel')).toBeNull();
  });
});
