// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Scene } from 'three';
import { ReferenceImageController } from '../src/scene/reference-image-controller';
import type { LoadedImage, ReferenceImageLoader } from '../src/scene/reference-image-loader';
import type { PlaneData, SceneObjectRender, SketchImageData } from '../src/types';

// The viewer's reference-image controller: which image() rows a render
// shows, one fetch per picture path across the re-renders every sketch edit
// causes, one quad per row placed from its record, and the Image tool's
// override drawn in place of the row it edits (or as a new picture) until
// cleared.

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
  const nodes = () => scene.children.filter(child => child.name === 'sketchReferenceImage');
  const status: (string | null)[] = [];
  ctl.onStatus = (m) => status.push(m);
  return { ctl, node, nodes, calls, render, status };
}

const MODEL = '/ws/parts/bracket.part.js';
const KEY_A = `${MODEL}:3:3`;
const KEY_B = `${MODEL}:4:3`;
const source = (over: Partial<SketchImageData> = {}, key = KEY_A) => ({ key, plane: XY, spec: spec(over), modelFile: MODEL });
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

describe('ReferenceImageController.sourcesOf', () => {
  const row = (over: Partial<SceneObjectRender>): SceneObjectRender => ({ id: 'x', visible: true, sceneShapes: [], ...over } as SceneObjectRender);
  const sketchRow = (id: string, visible: boolean) => row({ id, type: 'sketch', visible, object: { plane: XY } });
  const imageRow = (id: string, parentId: string, line: number, image: SketchImageData | null = spec()) => row({
    id, type: 'image', parentId, visible: false,
    object: image ? { image, plane: XY } : { plane: XY },
    sourceLocation: { filePath: MODEL, line, column: 3 },
  });
  const rows = [
    sketchRow('s1', true), imageRow('i1', 's1', 3),
    sketchRow('s2', false), imageRow('i2', 's2', 9),
    imageRow('i3', 's1', 4, null),
  ];

  it('shows the pictures of on-screen sketches outside sketch mode, a shown hidden sketch included', () => {
    expect(ReferenceImageController.sourcesOf(rows, null, new Set()).map(s => s.key)).toEqual([KEY_A]);
    expect(ReferenceImageController.sourcesOf(rows, null, new Set(['s2'])).map(s => s.key)).toEqual([KEY_A, `${MODEL}:9:3`]);
  });

  it('shows only the edited sketch\'s pictures in sketch mode, consumed or not', () => {
    expect(ReferenceImageController.sourcesOf(rows, 's2', new Set()).map(s => s.key)).toEqual([`${MODEL}:9:3`]);
  });

  it('leaves out a failed statement (no record) and carries the plane and model file', () => {
    const [only] = ReferenceImageController.sourcesOf(rows, 's1', new Set());
    expect(only).toEqual({ key: KEY_A, plane: XY, spec: spec(), modelFile: MODEL });
  });
});

describe('ReferenceImageController', () => {
  it('loads the picture once, places the quad, and re-syncs without a second fetch', async () => {
    const img = image();
    const { ctl, node, nodes, calls } = make({ [URL_A]: async () => img });
    ctl.sync([source()]);
    expect(nodes()).toHaveLength(0);
    expect(ctl.current(KEY_A)).toEqual({ spec: spec(), pixel: null });
    await flush();
    expect(calls).toEqual([URL_A]);
    expect(node().visible).toBe(true);
    expect(node().scale.x).toBeCloseTo(80);
    expect(node().scale.y).toBeCloseTo(40);
    expect(ctl.current(KEY_A)).toEqual({ spec: spec(), pixel: { width: 400, height: 200 } });
    expect(ctl.current(KEY_B)).toBeNull();

    // The sketch re-rendered with a moved picture: same bytes, new place.
    ctl.sync([source({ at: [5, 0], opacity: 0.2 })]);
    await flush();
    expect(calls).toEqual([URL_A]);
    expect(node().position.x).toBeCloseTo(5);
    expect((node().children[0] as any).material.opacity).toBe(0.2);
  });

  it('draws one quad per row, two rows sharing a file fetching it once', async () => {
    const { ctl, nodes, calls } = make({ [URL_A]: async () => image(), [URL_B]: async () => image(100, 100) });
    ctl.sync([source(), source({ at: [100, 0] }, KEY_B), source({ src: 'images/b.png' }, `${MODEL}:5:3`)]);
    await flush();
    expect(calls).toEqual([URL_A, URL_B]);
    expect(nodes()).toHaveLength(3);
    ctl.sync([source()]);
    expect(nodes()).toHaveLength(1);
  });

  it('removes the quads when no row shows and refetches nothing for a recent picture', async () => {
    const a = image();
    const { ctl, nodes, calls } = make({ [URL_A]: async () => a });
    ctl.sync([source()]);
    await flush();
    ctl.sync([]);
    expect(nodes()).toHaveLength(0);
    ctl.sync([source()]);
    await flush();
    expect(calls).toEqual([URL_A]);
    expect(nodes()).toHaveLength(1);
    expect(a.close).not.toHaveBeenCalled();
    ctl.dispose();
    expect(a.close).toHaveBeenCalled();
  });

  it('reports a failed load and draws nothing for that row', async () => {
    const { ctl, nodes, status } = make({});
    ctl.sync([source()]);
    await flush();
    expect(status).toEqual(['Reference image could not be loaded: File not found.']);
    expect(nodes()).toHaveLength(0);
  });

  it('ignores a load that lands after its picture was let go', async () => {
    let release!: (img: LoadedImage) => void;
    const slow = image();
    const loads: Record<string, () => Promise<LoadedImage>> = { [URL_A]: () => new Promise<LoadedImage>((resolve) => { release = resolve; }) };
    for (let i = 0; i < 6; i++) {
      loads[`api/files/raw?path=%2Fws%2Fparts%2Fimages%2F${i}.png`] = async () => image();
    }
    const { ctl, nodes } = make(loads);
    ctl.sync([source()]);
    // Six other pictures come and go: the idle cap lets the first one go.
    for (let i = 0; i < 6; i++) {
      ctl.sync([source({ src: `images/${i}.png` })]);
    }
    ctl.sync([]);
    release(slow);
    await flush();
    expect(nodes()).toHaveLength(0);
    expect(slow.close).toHaveBeenCalled();
  });

  it('draws the tool\'s override in place of the row it edits, or as a new picture, until cleared', async () => {
    const loaded = image();
    const chosen = image(300, 300);
    const { ctl, nodes } = make({ [URL_A]: async () => loaded });
    ctl.sync([source()]);
    await flush();

    // A new picture (no row yet) with its own decoded file: a second quad.
    ctl.preview({ key: null, plane: XY, spec: spec({ src: '', width: 50 }), modelFile: MODEL, image: chosen });
    expect(nodes()).toHaveLength(2);
    expect(nodes().some(n => Math.abs(n.scale.x - 50) < 1e-6 && Math.abs(n.scale.y - 50) < 1e-6)).toBe(true);
    ctl.clearPreview();
    expect(nodes()).toHaveLength(1);

    // Re-opening the row: the override replaces its quad, using the loaded picture, re-renders included.
    ctl.preview({ key: KEY_A, plane: XY, spec: spec({ width: 20 }), modelFile: MODEL });
    ctl.sync([source()]);
    expect(nodes()).toHaveLength(1);
    expect(nodes()[0].scale.x).toBeCloseTo(20);
    expect(nodes()[0].scale.y).toBeCloseTo(10);
    expect(ctl.current(KEY_A)!.spec.width).toBe(80);

    ctl.clearPreview();
    expect(nodes()[0].scale.x).toBeCloseTo(80);
  });

  it('hides a row the timeline eye hid, keeps seeding the tool from it, and draws the tool\'s override over it', async () => {
    const loaded = image();
    const { ctl, nodes } = make({ [URL_A]: async () => loaded, [URL_B]: async () => image() });
    ctl.sync([source(), source({ src: 'images/b.png' }, KEY_B)]);
    await flush();
    expect(nodes()).toHaveLength(2);

    ctl.setHidden(new Set([KEY_A]));
    expect(nodes()).toHaveLength(1);
    ctl.sync([source(), source({ src: 'images/b.png' }, KEY_B)]);
    expect(nodes()).toHaveLength(1);
    expect(ctl.current(KEY_A)).toEqual({ spec: spec(), pixel: { width: 400, height: 200 } });

    ctl.preview({ key: KEY_A, plane: XY, spec: spec({ width: 20 }), modelFile: MODEL });
    expect(nodes()).toHaveLength(2);
    ctl.clearPreview();
    expect(nodes()).toHaveLength(1);

    ctl.setHidden(new Set());
    expect(nodes()).toHaveLength(2);
  });
});
