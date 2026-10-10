// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Scene } from 'three';
import { ReferenceImageController } from '../src/scene/reference-image-controller';
import type { LoadedImage, ReferenceImageLoader } from '../src/scene/reference-image-loader';
import type { PlaneData, SketchImageData } from '../src/types';

// The viewer's reference-image controller: one fetch per picture path across
// the re-renders every sketch edit causes, the quad placed from the model's
// record, hidden when sketch mode ends, and the Image dialog's override
// drawn in its place until cleared.

const XY: PlaneData = {
  origin: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 }, xDirection: { x: 1, y: 0, z: 0 }, yDirection: { x: 0, y: 1, z: 0 },
};
const spec = (over: Partial<SketchImageData> = {}): SketchImageData => ({ src: 'images/a.png', width: 80, at: [0, 0], angle: 0, opacity: 0.5, ...over });
const image = (w = 400, h = 200): LoadedImage => ({ source: {} as any, width: w, height: h, close: vi.fn() });
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function make(loads: Record<string, () => Promise<LoadedImage>> = {}) {
  const scene = new Scene();
  const calls: string[] = [];
  const loader = {
    load: vi.fn(async (url: string) => {
      calls.push(url);
      const make = loads[url];
      if (!make) {
        throw new Error('File not found.');
      }
      return make();
    }),
  } as unknown as ReferenceImageLoader;
  const render = vi.fn();
  const ctl = new ReferenceImageController(scene, loader, render);
  const node = () => scene.getObjectByName('sketchReferenceImage')!;
  const status: (string | null)[] = [];
  ctl.onStatus = (m) => status.push(m);
  return { ctl, node, calls, render, status };
}

const URL_A = 'api/files/raw?path=%2Fws%2Fparts%2Fimages%2Fa.png';
const URL_B = 'api/files/raw?path=%2Fws%2Fparts%2Fimages%2Fb.png';

describe('ReferenceImageController.resolveSrc', () => {
  it('joins a relative path onto the model file folder and folds dot segments', () => {
    expect(ReferenceImageController.resolveSrc('/ws/parts/bracket.part.js', 'images/a.png')).toBe('/ws/parts/images/a.png');
    expect(ReferenceImageController.resolveSrc('/ws/parts/bracket.part.js', './images/a.png')).toBe('/ws/parts/images/a.png');
    expect(ReferenceImageController.resolveSrc('/ws/parts/bracket.part.js', '../shared/a.png')).toBe('/ws/shared/a.png');
    expect(ReferenceImageController.resolveSrc('C:\\ws\\bracket.part.js', 'images\\a.png')).toBe('C:/ws/images/a.png');
  });

  it('keeps an absolute path', () => {
    expect(ReferenceImageController.resolveSrc('/ws/bracket.part.js', '/elsewhere/a.png')).toBe('/elsewhere/a.png');
    expect(ReferenceImageController.resolveSrc('/ws/bracket.part.js', 'D:/pics/a.png')).toBe('D:/pics/a.png');
  });

  it('serves it through the raw file route', () => {
    expect(ReferenceImageController.imageUrl('/ws/parts/bracket.part.js', 'images/a.png')).toBe(URL_A);
  });
});

describe('ReferenceImageController', () => {
  it('loads the picture once, places the quad, and re-syncs without a second fetch', async () => {
    const img = image();
    const { ctl, node, calls } = make({ [URL_A]: async () => img });
    ctl.sync({ plane: XY, spec: spec(), modelFile: '/ws/parts/bracket.part.js' });
    expect(node().visible).toBe(false);
    expect(ctl.current()).toEqual({ spec: spec(), pixel: null });
    await flush();
    expect(calls).toEqual([URL_A]);
    expect(node().visible).toBe(true);
    expect(node().scale.x).toBeCloseTo(80);
    expect(node().scale.y).toBeCloseTo(40);
    expect(ctl.current()).toEqual({ spec: spec(), pixel: { width: 400, height: 200 } });

    // The sketch re-rendered with a moved picture: same bytes, new place.
    ctl.sync({ plane: XY, spec: spec({ at: [5, 0], opacity: 0.2 }), modelFile: '/ws/parts/bracket.part.js' });
    await flush();
    expect(calls).toEqual([URL_A]);
    expect(node().position.x).toBeCloseTo(5);
    expect((node().children[0] as any).material.opacity).toBe(0.2);
  });

  it('hides on sketch exit and fetches a changed path, closing the old picture', async () => {
    const a = image();
    const b = image(100, 100);
    const { ctl, node, calls } = make({ [URL_A]: async () => a, [URL_B]: async () => b });
    ctl.sync({ plane: XY, spec: spec(), modelFile: '/ws/parts/bracket.part.js' });
    await flush();
    ctl.sync(null);
    expect(node().visible).toBe(false);

    ctl.sync({ plane: XY, spec: spec({ src: 'images/b.png' }), modelFile: '/ws/parts/bracket.part.js' });
    await flush();
    expect(calls).toEqual([URL_A, URL_B]);
    expect(a.close).toHaveBeenCalled();
    expect(node().visible).toBe(true);
    expect(node().scale.y).toBeCloseTo(80);
  });

  it('reports a failed load and keeps the quad hidden; a later success clears the message', async () => {
    const { ctl, node, status } = make({ [URL_B]: async () => image() });
    ctl.sync({ plane: XY, spec: spec(), modelFile: '/ws/parts/bracket.part.js' });
    await flush();
    expect(status).toEqual(['Reference image could not be loaded: File not found.']);
    expect(node().visible).toBe(false);
    ctl.sync({ plane: XY, spec: spec({ src: 'images/b.png' }), modelFile: '/ws/parts/bracket.part.js' });
    await flush();
    expect(status).toEqual(['Reference image could not be loaded: File not found.', null]);
    expect(node().visible).toBe(true);
  });

  it('ignores a load that lands after the sketch left', async () => {
    let release!: (img: LoadedImage) => void;
    const slow = image();
    const { ctl, node } = make({ [URL_A]: () => new Promise<LoadedImage>((resolve) => { release = resolve; }) });
    ctl.sync({ plane: XY, spec: spec(), modelFile: '/ws/parts/bracket.part.js' });
    ctl.sync(null);
    release(slow);
    await flush();
    expect(node().visible).toBe(false);
    expect(slow.close).toHaveBeenCalled();
  });

  it('draws the dialog override over the model, with its own picture when given, until cleared', async () => {
    const loaded = image();
    const chosen = image(300, 300);
    const { ctl, node } = make({ [URL_A]: async () => loaded });
    // Preview before any model record (a sketch without an image yet).
    ctl.preview(XY, spec({ width: 50 }), chosen);
    expect(node().visible).toBe(true);
    expect(node().scale.x).toBeCloseTo(50);
    expect(node().scale.y).toBeCloseTo(50);
    expect(ctl.current()).toBeNull();

    // The model arrives: the override still wins, re-renders included.
    ctl.sync({ plane: XY, spec: spec(), modelFile: '/ws/parts/bracket.part.js' });
    await flush();
    expect(node().scale.x).toBeCloseTo(50);
    expect(ctl.current()!.spec.width).toBe(80);

    // An override without its own picture uses the loaded one.
    ctl.preview(XY, spec({ width: 20 }));
    expect(node().scale.x).toBeCloseTo(20);
    expect(node().scale.y).toBeCloseTo(10);

    ctl.clearPreview();
    expect(node().scale.x).toBeCloseTo(80);
    ctl.sync(null);
    ctl.clearPreview();
    expect(node().visible).toBe(false);
  });
});
