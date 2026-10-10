// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Scene, Vector3 } from 'three';
import { SketchReferenceImage } from '../src/scene/sketch-reference-image';
import type { PlaneData, SketchImageData } from '../src/types';

// The reference picture quad: placed in the sketch frame (centre, in-plane
// rotation, size from the written side plus the pixel aspect) and drawn in
// the slot between the grid and the sketch's lines.

const XY: PlaneData = {
  origin: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 }, xDirection: { x: 1, y: 0, z: 0 }, yDirection: { x: 0, y: 1, z: 0 },
};
// A plane standing on the x axis, facing −y: x → world x, y → world z.
const XZ: PlaneData = {
  origin: { x: 10, y: 5, z: 0 }, center: { x: 10, y: 5, z: 0 },
  normal: { x: 0, y: -1, z: 0 }, xDirection: { x: 1, y: 0, z: 0 }, yDirection: { x: 0, y: 0, z: 1 },
};
const spec = (over: Partial<SketchImageData> = {}): SketchImageData => ({ src: 'a.png', width: 80, at: [0, 0], angle: 0, opacity: 0.5, ...over });
const near = (v: Vector3, x: number, y: number, z: number) => {
  expect(v.x).toBeCloseTo(x, 6);
  expect(v.y).toBeCloseTo(y, 6);
  expect(v.z).toBeCloseTo(z, 6);
};

describe('SketchReferenceImage.resolveSize', () => {
  it('derives the missing side from the pixel aspect and keeps an explicit pair', () => {
    const pixel = { width: 400, height: 200 };
    expect(SketchReferenceImage.resolveSize({ width: 80 }, pixel)).toEqual({ width: 80, height: 40 });
    expect(SketchReferenceImage.resolveSize({ height: 30 }, pixel)).toEqual({ width: 60, height: 30 });
    expect(SketchReferenceImage.resolveSize({ width: 80, height: 10 }, pixel)).toEqual({ width: 80, height: 10 });
  });

  it('is square without a picture to read the aspect from', () => {
    expect(SketchReferenceImage.resolveSize({ width: 80 }, null)).toEqual({ width: 80, height: 80 });
  });
});

describe('SketchReferenceImage.placement', () => {
  it('centres the quad at `at` in the plane frame', () => {
    const p = SketchReferenceImage.placement(XZ, spec({ at: [3, 4] }), { width: 100, height: 50 });
    near(p.position, 13, 5, 4);
    expect(p.width).toBe(80);
    expect(p.height).toBe(40);
    // The quad's local z (its facing) is the plane normal, its local x the plane x.
    near(new Vector3(0, 0, 1).applyQuaternion(p.quaternion), 0, -1, 0);
    near(new Vector3(1, 0, 0).applyQuaternion(p.quaternion), 1, 0, 0);
  });

  it('turns the quad about the plane normal, counter-clockwise in the sketch frame', () => {
    const p = SketchReferenceImage.placement(XY, spec({ angle: 90 }), null);
    near(new Vector3(1, 0, 0).applyQuaternion(p.quaternion), 0, 1, 0);
    near(new Vector3(0, 1, 0).applyQuaternion(p.quaternion), -1, 0, 0);
    near(new Vector3(0, 0, 1).applyQuaternion(p.quaternion), 0, 0, 1);
  });
});

describe('SketchReferenceImage quad', () => {
  const fakeImage = () => ({ source: {} as any, width: 400, height: 200, close: () => {} });

  it('is scene furniture in the slot under the sketch lines, hidden until it has a picture', () => {
    const scene = new Scene();
    const quad = new SketchReferenceImage(scene);
    const node = scene.getObjectByName('sketchReferenceImage')!;
    expect(node).toBeDefined();
    expect(node.userData.isMetaShape).toBe(true);
    expect(node.visible).toBe(false);
    const mesh = node.children[0] as any;
    expect(mesh.renderOrder).toBe(0.5);
    expect(mesh.material.transparent).toBe(true);
    expect(mesh.material.depthWrite).toBe(false);
    expect(mesh.material.depthTest).toBe(true);
    expect(mesh.material.polygonOffset).toBe(true);
    expect(mesh.material.polygonOffsetFactor).toBe(0.5);
    expect(mesh.material.polygonOffsetUnits).toBe(0.5);
    expect(mesh.material.toneMapped).toBe(false);

    // Placing without a picture keeps it hidden; with one it shows at the spec's opacity and size.
    quad.place(XY, spec());
    expect(node.visible).toBe(false);
    quad.setImage(fakeImage());
    expect(quad.pixelSize).toEqual({ width: 400, height: 200 });
    quad.place(XY, spec({ opacity: 0.3 }));
    expect(node.visible).toBe(true);
    expect(mesh.material.opacity).toBe(0.3);
    near(node.scale, 80, 40, 1);

    quad.setImage(null);
    expect(node.visible).toBe(false);
    quad.dispose();
    expect(scene.getObjectByName('sketchReferenceImage')).toBeUndefined();
  });
});
