// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  BoxGeometry,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  Object3D,
  Plane,
  Vector3,
} from 'three';
import { SectionCaps, SectionController, SectionPlaneMath, SectionPlanes } from '../src/scene/section-controller';

/** A solid the way SolidMesh builds one: an `isSolid` group holding a face-mesh group holding the mesh. */
function solid(size: number, color = '#ff8800'): { solid: Group; mesh: Mesh; material: MeshPhongMaterial } {
  const group = new Group();
  group.userData.isSolid = true;
  const faces = new Group();
  const material = new MeshPhongMaterial({ color });
  const mesh = new Mesh(new BoxGeometry(size, size, size), material);
  mesh.userData.faceMapping = [];
  faces.add(mesh);
  group.add(faces);
  return { solid: group, mesh, material };
}

function overlays(root: Object3D): Object3D[] {
  const found: Object3D[] = [];
  root.traverse((node) => {
    if (node.userData.isSectionOverlay) {
      found.push(node);
    }
  });
  return found;
}

function markers(root: Object3D): Mesh[] {
  return overlays(root).filter((node) => node.userData.isSectionMarker) as Mesh[];
}

function caps(root: Object3D): Mesh[] {
  return overlays(root).filter((node) => node.userData.isSectionCap) as Mesh[];
}

function materialsUnder(root: Object3D): Material[] {
  const found = new Set<Material>();
  root.traverse((node) => {
    const material = (node as Mesh).material as Material | Material[] | undefined;
    if (!material) {
      return;
    }
    for (const m of Array.isArray(material) ? material : [material]) {
      found.add(m);
    }
  });
  return [...found];
}

describe('SectionController.apply', () => {
  it('clips the model on the kept side of the plane and caps the solid it cuts', () => {
    const root = new Group();
    const { solid: body, mesh, material } = solid(10);
    root.add(body);

    const controller = new SectionController();
    controller.apply(root, { plane: 'xy' });

    expect(material.clippingPlanes).toHaveLength(1);
    const plane = material.clippingPlanes![0] as Plane;
    expect(plane.normal.toArray()).toEqual([-0, -0, -1]);
    expect(plane.constant).toBe(0);
    // Kept below, discarded above.
    expect(plane.distanceToPoint(new Vector3(0, 0, -3))).toBeGreaterThan(0);
    expect(plane.distanceToPoint(new Vector3(0, 0, 3))).toBeLessThan(0);

    // Two stencil markers (back faces count up, front faces count down) on the mesh, clipped like it.
    const found = markers(root);
    expect(found).toHaveLength(2);
    for (const marker of found) {
      expect(marker.parent).toBe(mesh);
      const m = marker.material as MeshBasicMaterial;
      expect(m.stencilWrite).toBe(true);
      expect(m.colorWrite).toBe(false);
      expect(m.depthWrite).toBe(false);
      expect(m.clippingPlanes).toEqual([plane]);
      expect(marker.renderOrder).toBe(SectionCaps.RENDER_ORDER_BASE);
    }
    expect(found.map((m) => (m.material as MeshBasicMaterial).side).sort()).toEqual([0, 1]);

    // One cap quad on the plane, facing the removed half, drawn after its markers, never clipped.
    const [cap] = caps(root);
    expect(caps(root)).toHaveLength(1);
    expect(cap.position.toArray()).toEqual([0, 0, 0]);
    expect(new Vector3(0, 0, 1).applyQuaternion(cap.quaternion).toArray().map((n) => Math.round(n * 1e6) / 1e6)).toEqual([0, 0, 1]);
    expect(cap.renderOrder).toBe(SectionCaps.RENDER_ORDER_BASE + 1);
    const capMaterial = cap.material as MeshPhongMaterial;
    expect(capMaterial.stencilWrite).toBe(true);
    expect(capMaterial.stencilRef).toBe(0);
    expect(capMaterial.clippingPlanes).toEqual([]);
    expect(capMaterial.color.getHex()).toBe(SectionCaps.capColor([mesh]).getHex());
    expect(capMaterial.color.getHexString()).not.toBe(material.color.getHexString());
    expect(controller.current).toEqual({ plane: 'xy' });
  });

  it('flip faces the cap the other way and keeps the other half', () => {
    const root = new Group();
    root.add(solid(10).solid);
    const controller = new SectionController();
    controller.apply(root, { plane: 'xy', flip: true });
    const [cap] = caps(root);
    expect(new Vector3(0, 0, 1).applyQuaternion(cap.quaternion).z).toBeCloseTo(-1, 9);
    const plane = (materialsUnder(root)[0] as MeshPhongMaterial).clippingPlanes![0] as Plane;
    expect(plane.distanceToPoint(new Vector3(0, 0, 3))).toBeGreaterThan(0);
  });

  it('caps nothing on a solid that lies entirely on one side, and only the cut solids of several', () => {
    const root = new Group();
    const low = solid(10);
    const high = solid(10);
    high.solid.position.set(0, 0, 30);
    root.add(low.solid, high.solid);

    const controller = new SectionController();
    controller.apply(root, { plane: 'xy', offset: 30 });
    // The low body (z -5..5) is wholly kept; the high one (z 25..35) is cut at its middle.
    expect(caps(root)).toHaveLength(1);
    expect(caps(root)[0].position.toArray()).toEqual([0, 0, 30]);
    expect(markers(root).every((m) => m.parent === high.mesh)).toBe(true);
    expect(low.material.clippingPlanes).toHaveLength(1);

    controller.apply(root, { plane: 'xy', offset: 100 });
    expect(caps(root)).toHaveLength(0);
    expect(markers(root)).toHaveLength(0);
  });

  it('numbers several caps so each solid\'s markers precede its own quad', () => {
    const root = new Group();
    for (let i = 0; i < 3; i++) {
      const body = solid(4);
      body.solid.position.set(i * 10, 0, 0);
      root.add(body.solid);
    }
    new SectionController().apply(root, { plane: 'xy' });
    const orders = caps(root).map((c) => c.renderOrder).sort((a, b) => a - b);
    expect(orders).toEqual([-999, -997, -995]);
    const markerOrders = new Set(markers(root).map((m) => m.renderOrder));
    expect([...markerOrders].sort((a, b) => a - b)).toEqual([-1000, -998, -996]);
  });

  it('skips hidden solids, meta shapes and select overlays', () => {
    const root = new Group();
    const hidden = solid(10);
    hidden.solid.visible = false;
    const meta = solid(10);
    meta.solid.userData.isMetaShape = true;
    const select = solid(10);
    select.solid.renderOrder = 999;
    root.add(hidden.solid, meta.solid, select.solid);
    new SectionController().apply(root, { plane: 'xy' });
    expect(caps(root)).toHaveLength(0);
  });

  it('clips a highlight overlay mesh inside the root like the model', () => {
    const root = new Group();
    root.add(solid(10).solid);
    const highlight = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial({ depthTest: false, transparent: true }));
    root.add(highlight);
    new SectionController().apply(root, { plane: 'xy' });
    expect((highlight.material as MeshBasicMaterial).clippingPlanes).toHaveLength(1);
  });

  it('re-applying with a new spec replaces the previous overlays instead of stacking them', () => {
    const root = new Group();
    root.add(solid(10).solid);
    const controller = new SectionController();
    controller.apply(root, { plane: 'xy' });
    const first = overlays(root);
    controller.apply(root, { plane: 'yz', offset: 1 });
    const second = overlays(root);
    expect(second).toHaveLength(first.length);
    expect(second.some((node) => first.includes(node))).toBe(false);
    expect(caps(root)[0].position.toArray()).toEqual([1, 0, 0]);
  });
});

describe('SectionController.clear', () => {
  it('removes every overlay, disposes what it created, and hands materials their prior clipping back', () => {
    const root = new Group();
    const { solid: body, material } = solid(10);
    root.add(body);
    const sketchPlane = new Plane(new Vector3(0, 1, 0), 2);
    material.clippingPlanes = [sketchPlane];
    const untouched = solid(10);
    root.add(untouched.solid);

    const controller = new SectionController();
    controller.apply(root, { plane: 'xy' });
    const created = overlays(root);
    expect(created.length).toBeGreaterThan(0);
    const disposers = created.flatMap((node) => {
      const mesh = node as Mesh;
      const spies: ReturnType<typeof vi.spyOn>[] = [];
      if (mesh.geometry) {
        spies.push(vi.spyOn(mesh.geometry, 'dispose'));
      }
      if (mesh.material) {
        spies.push(vi.spyOn(mesh.material as Material, 'dispose'));
      }
      return spies;
    });
    const modelDispose = vi.spyOn(material, 'dispose');

    controller.clear();

    expect(overlays(root)).toHaveLength(0);
    expect(root.getObjectByName(SectionCaps.GROUP_NAME)).toBeUndefined();
    for (const spy of disposers) {
      expect(spy).toHaveBeenCalled();
    }
    expect(modelDispose).not.toHaveBeenCalled();
    expect(material.clippingPlanes).toEqual([sketchPlane]);
    expect(untouched.material.clippingPlanes).toBeNull();
    expect(controller.current).toBeNull();
    // Clearing twice is harmless.
    controller.clear();
  });
});

describe('SectionCaps.markerPartition', () => {
  it('leaves coplanar triangles out of the clipped pass and counts them unclipped only when their normal points into the removed half', () => {
    const { mesh } = solid(10);
    mesh.updateMatrixWorld(true);
    // The box's top face (z = 5) lies on the plane. Default: everything above is removed, the top face's
    // outward normal (+z) points into the removed half, so the box below is kept and its face covers the cut.
    const kept = SectionPlaneMath.resolve({ plane: 'xy', offset: 5 });
    const partition = SectionCaps.markerPartition(mesh, kept, SectionPlanes.clipPlane(kept))!;
    expect(partition.clipped.length).toBe(10 * 3 * 3);
    expect(partition.coplanarKept.length).toBe(2 * 3 * 3);
    expect(Array.from(partition.coplanarKept).filter((_, i) => i % 3 === 2).every((z) => z === 5)).toBe(true);

    // Flipped: the box is the removed body and its top face bounds it towards the kept half; no cap must be counted.
    const removed = SectionPlaneMath.resolve({ plane: 'xy', offset: 5, flip: true });
    const flipped = SectionCaps.markerPartition(mesh, removed, SectionPlanes.clipPlane(removed))!;
    expect(flipped.clipped.length).toBe(10 * 3 * 3);
    expect(flipped.coplanarKept.length).toBe(0);
  });

  it('straddles is true only when the bounds have corners on both sides', () => {
    const { mesh } = solid(10);
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox!;
    expect(SectionCaps.straddles(box, SectionPlaneMath.resolve({ plane: 'xy' }))).toBe(true);
    expect(SectionCaps.straddles(box, SectionPlaneMath.resolve({ plane: 'xy', offset: 5 }))).toBe(false);
    expect(SectionCaps.straddles(box, SectionPlaneMath.resolve({ plane: 'xy', offset: 4.9 }))).toBe(true);
    expect(SectionCaps.straddles(box, SectionPlaneMath.resolve({ plane: 'xy', offset: -5, flip: true }))).toBe(false);
  });
});
