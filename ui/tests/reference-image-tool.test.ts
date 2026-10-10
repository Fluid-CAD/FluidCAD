// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReferenceImageTool } from '../src/interactive/tools/reference-image-tool';
import { ReferenceImagePanel } from '../src/interactive/tools/reference-image-panel';
import type { LoadedImage } from '../src/scene/reference-image-loader';
import type { PlaneData } from '../src/types';

// The Image tool's flows, driven against its panel with the scene, the
// upload and the commit stubbed: a chosen file is uploaded beside the model
// and the chain written with the relative path; edits preview through the
// host; Remove writes null; Cancel drops the preview; a refused commit stays
// open with the reason.

const XY: PlaneData = {
  origin: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 }, xDirection: { x: 1, y: 0, z: 0 }, yDirection: { x: 0, y: 1, z: 0 },
};
const LOC = { filePath: '/ws/parts/bracket.part.js', line: 7, column: 1 };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const image = (w: number, h: number): LoadedImage => ({ source: {} as any, width: w, height: h, close: vi.fn() });

function makeTool(opts: { current?: { spec: any; pixel: any } | null; commitResult?: { success: boolean; reason?: string } } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const host = {
    current: vi.fn(() => opts.current ?? null),
    preview: vi.fn(),
    clearPreview: vi.fn(),
  };
  const upload = vi.fn(async (path: string, _data: string) => ({ path: 'parts/images/pic.png', absPath: path.replace(/\/images\/.*$/, '/images/pic.png'), size: 3 }));
  const commit = vi.fn(async () => opts.commitResult ?? { success: true });
  const decode = vi.fn(async () => image(400, 200));
  const onRequestExit = vi.fn();
  const tool: any = Object.create(ReferenceImageTool.prototype);
  tool.plane = XY;
  tool.canvas = document.createElement('canvas');
  tool.host = host;
  tool.sourceLocation = LOC;
  tool.onRequestExit = onRequestExit;
  tool.upload = upload;
  tool.commit = commit;
  tool.decode = decode;
  tool.chosen = null;
  tool.busy = false;
  tool.boundMouseDown = tool.handleMouseDown.bind(tool);
  tool.boundMouseUp = tool.handleMouseUp.bind(tool);
  tool.panel = new ReferenceImagePanel(container);
  tool.panel.onChange = () => tool.refreshPreview();
  tool.panel.onApply = () => void tool.apply();
  tool.panel.onRemove = () => void tool.remove();
  tool.panel.onExit = () => tool.cancel();
  tool.panel.onFile = (file: File) => void tool.chooseFile(file);
  tool.snapAt = vi.fn(() => [12, -3]);
  const root = container.querySelector<HTMLElement>('#fluidcad-reference-image-panel')!;
  const field = (role: string) => root.querySelector<HTMLInputElement>(`[data-role="${role}"]`)!;
  const type = (role: string, value: string) => {
    field(role).value = value;
    field(role).dispatchEvent(new Event('input', { bubbles: true }));
  };
  const message = () => root.querySelector<HTMLElement>('[data-role="message"]')!;
  return { tool, host, upload, commit, decode, onRequestExit, field, type, message };
}

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
});

describe('ReferenceImageTool', () => {
  it('opens seeded from the sketch record and previews the fields as they change', () => {
    const { tool, host, field, type } = makeTool({ current: { spec: { src: 'images/a.png', width: 80, at: [1, 2], angle: 0, opacity: 0.5 }, pixel: { width: 200, height: 100 } } });
    tool.onActivate();
    expect(field('width').value).toBe('80');
    expect(field('height').value).toBe('40');
    expect(host.preview).toHaveBeenLastCalledWith(XY, { src: 'images/a.png', width: 80, at: [1, 2], angle: 0, opacity: 0.5 }, null);
    type('opacity', '20');
    expect(host.preview).toHaveBeenLastCalledWith(XY, expect.objectContaining({ opacity: 0.2 }), null);
  });

  it('a click in the viewport moves the centre to the snapped point', () => {
    const { tool, host, field } = makeTool({ current: { spec: { src: 'a.png', width: 80, at: [0, 0], angle: 0, opacity: 0.5 }, pixel: null } });
    tool.onActivate();
    tool.canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100, button: 0 }));
    tool.canvas.dispatchEvent(new MouseEvent('mouseup', { clientX: 103, clientY: 101, button: 0 }));
    expect(field('x').value).toBe('12');
    expect(field('y').value).toBe('-3');
    expect(host.preview).toHaveBeenLastCalledWith(XY, expect.objectContaining({ at: [12, -3] }), null);
    // A drag is the camera's, not a placement.
    tool.canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100, button: 0 }));
    tool.canvas.dispatchEvent(new MouseEvent('mouseup', { clientX: 140, clientY: 100, button: 0 }));
    expect(field('x').value).toBe('12');
  });

  it('uploads a chosen file beside the model and writes the chain with the relative path', async () => {
    const { tool, host, upload, commit, decode, onRequestExit, field, type } = makeTool();
    tool.onActivate();
    expect(host.preview).not.toHaveBeenCalled();
    const file = new File([new Uint8Array([1, 2, 3])], 'Side View.png', { type: 'image/png' });
    await tool.chooseFile(file);
    expect(decode).toHaveBeenCalledWith(file);
    expect(field('file-label').textContent).toBe('Side View.png · 400×200 px');
    // The chosen picture previews before it is on disk.
    expect(host.preview).toHaveBeenLastCalledWith(XY, expect.objectContaining({ src: '', width: 100 }), expect.objectContaining({ width: 400 }));

    type('width', '120');
    field('apply').click();
    await flush();
    await flush();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][0]).toBe('/ws/parts/images/Side-View.png');
    expect(upload.mock.calls[0][1]).toBe('AQID');
    expect(commit).toHaveBeenCalledWith(LOC, { src: 'images/pic.png', width: 120, at: [0, 0], angle: 0, opacity: 0.5 });
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

  it('Apply on an existing record without a new file commits the fields as they stand', async () => {
    const { tool, upload, commit, type, field } = makeTool({ current: { spec: { src: 'images/a.png', width: 80, at: [0, 0], angle: 0, opacity: 0.5 }, pixel: { width: 200, height: 100 } } });
    tool.onActivate();
    type('angle', '45');
    field('apply').click();
    await flush();
    expect(upload).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledWith(LOC, { src: 'images/a.png', width: 80, at: [0, 0], angle: 45, opacity: 0.5 });
  });

  it('a refused commit keeps the dialog open with the reason', async () => {
    const { tool, onRequestExit, host, field, message } = makeTool({
      current: { spec: { src: 'images/a.png', width: 80, at: [0, 0], angle: 0, opacity: 0.5 }, pixel: null },
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

  it('Remove writes null; Cancel drops the preview and exits through the toolbar, never on its own', async () => {
    const { tool, commit, host, onRequestExit, field } = makeTool({ current: { spec: { src: 'images/a.png', width: 80, at: [0, 0], angle: 0, opacity: 0.5 }, pixel: null } });
    tool.onActivate();
    field('remove').click();
    await flush();
    expect(commit).toHaveBeenCalledWith(LOC, null);
    expect(host.clearPreview).toHaveBeenCalledTimes(1);
    expect(onRequestExit).toHaveBeenCalledTimes(1);

    field('exit').click();
    expect(host.clearPreview).toHaveBeenCalledTimes(2);
    expect(onRequestExit).toHaveBeenCalledTimes(2);
    // The toolbar's deselect asks the tool about Escape first and would
    // loop if the tool answered by exiting again — so it has no such hook.
    expect(tool.handleEscape).toBeUndefined();
  });

  it('deactivating frees the chosen picture and clears the preview', async () => {
    const { tool, host } = makeTool();
    tool.onActivate();
    await tool.chooseFile(new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }));
    const chosen = tool.chosen.image;
    tool.onDeactivate();
    expect(chosen.close).toHaveBeenCalled();
    expect(host.clearPreview).toHaveBeenCalled();
    expect(document.querySelector('#fluidcad-reference-image-panel')).toBeNull();
  });
});
