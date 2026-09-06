// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Box3, Mesh, MeshBasicMaterial, Object3D, Raycaster, Scene, Vector3 } from 'three';
import { StandardPlanes } from '../src/scene/standard-planes';
import { worldFromMm } from '../src/units/scene-scale';

// The origin planes an armed plane slot shows as pick targets: sized past
// the scene, raycastable by plane id, narrowed to a subset on demand (the
// plane dialog keeps only its chosen bases once its list is full), hover
// tint, and gone on hide.

type Id = 'xy' | 'xz' | 'yz';

function shown(planes?: readonly Id[], bounds: Box3 | null = null): { quads: StandardPlanes; scene: Scene; group: Object3D } {
  const scene = new Scene();
  const quads = new StandardPlanes();
  quads.show(scene, bounds, planes);
  scene.updateMatrixWorld(true);
  const group = scene.getObjectByName('standardPlanes')!;
  return { quads, scene, group };
}

/** The quad for `id`, shown or not — read off the group, not the pick targets. */
function quadFor(group: Object3D, id: Id): Mesh {
  return group.children.find(c => c.userData.standardPlane === id) as Mesh;
}

function fillOpacity(group: Object3D, id: Id): number {
  return (quadFor(group, id).material as MeshBasicMaterial).opacity;
}

/** Which planes a ray straight down the -y axis from above the origin hits. */
function hitsFromAbove(quads: StandardPlanes): (Id | null)[] {
  const raycaster = new Raycaster();
  raycaster.set(new Vector3(5, 10, 5), new Vector3(0, -1, 0));
  return raycaster.intersectObjects(quads.pickTargets, false).map(h => quads.planeIdFor(h.object));
}

describe('StandardPlanes', () => {
  it('is hidden until shown and offers three pick targets while visible', () => {
    const quads = new StandardPlanes();
    expect(quads.visible).toBe(false);
    expect(quads.pickTargets).toEqual([]);
    expect(quads.shownPlanes).toEqual([]);

    const scene = new Scene();
    quads.show(scene, null);
    expect(quads.visible).toBe(true);
    expect(quads.shownPlanes).toEqual(['xy', 'xz', 'yz']);
    expect(quads.pickTargets.map(q => quads.planeIdFor(q))).toEqual(['xy', 'xz', 'yz']);
    expect(quads.planeIdFor(new Object3D())).toBeNull();

    quads.hide();
    expect(quads.visible).toBe(false);
    expect(quads.pickTargets).toEqual([]);
    expect(quads.shownPlanes).toEqual([]);
    expect(scene.getObjectByName('standardPlanes')).toBeUndefined();
  });

  it('scales past the scene bounds, with a default extent on an empty scene', () => {
    const empty = shown();
    expect(empty.group.scale.x).toBeCloseTo(worldFromMm(50), 9);

    const sized = shown(undefined, new Box3(new Vector3(-10, -4, 0), new Vector3(30, 8, 12)));
    // The farthest coordinate from the origin (30) times the margin.
    expect(sized.group.scale.x).toBeCloseTo(30 * 1.25, 9);

    const tiny = shown(undefined, new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)));
    expect(tiny.group.scale.x).toBeCloseTo(worldFromMm(10), 9);
  });

  it('raycasts to the plane under the cursor', () => {
    const { quads } = shown(undefined, new Box3(new Vector3(-50, -50, -50), new Vector3(50, 50, 50)));
    // Straight down onto the ground: only the xz quad (y = 0) lies across
    // the ray; xy (z = 0) and yz (x = 0) run parallel to it, off to the side.
    expect(hitsFromAbove(quads)).toEqual(['xz']);
  });

  it('shows only the planes named — the rest neither draw nor pick', () => {
    const { quads, group } = shown(['xy', 'yz'], new Box3(new Vector3(-50, -50, -50), new Vector3(50, 50, 50)));
    expect(quads.visible).toBe(true);
    expect(quads.shownPlanes).toEqual(['xy', 'yz']);
    expect(quads.pickTargets.map(q => quads.planeIdFor(q))).toEqual(['xy', 'yz']);
    expect(quadFor(group, 'xz').visible).toBe(false);
    expect(quadFor(group, 'xy').visible).toBe(true);
    expect(quadFor(group, 'yz').visible).toBe(true);
    // The ground quad is out of the subset, so the ray that hit it above finds nothing.
    expect(hitsFromAbove(quads)).toEqual([]);
  });

  it('re-showing swaps the subset in place, in canonical order', () => {
    const { quads, scene, group } = shown();
    quads.show(scene, null, ['yz', 'xz']);
    expect(scene.getObjectByName('standardPlanes')).toBe(group);
    expect(quads.shownPlanes).toEqual(['xz', 'yz']);
    expect(quadFor(group, 'xy').visible).toBe(false);

    quads.show(scene, null);
    expect(quads.shownPlanes).toEqual(['xy', 'xz', 'yz']);
    expect(quadFor(group, 'xy').visible).toBe(true);
  });

  it('naming no plane at all is a hide', () => {
    const { quads, scene } = shown();
    quads.show(scene, null, []);
    expect(quads.visible).toBe(false);
    expect(quads.pickTargets).toEqual([]);
    expect(scene.getObjectByName('standardPlanes')).toBeUndefined();

    // And a fresh instance never enters the scene for an empty subset.
    const fresh = new StandardPlanes();
    fresh.show(scene, null, []);
    expect(fresh.visible).toBe(false);
  });

  it('brightens the hovered quad, and reports changes only', () => {
    const { quads, group } = shown();
    const rest = fillOpacity(group, 'xz');

    expect(quads.setHover('xz')).toBe(true);
    expect(quads.setHover('xz')).toBe(false);
    expect(quads.hoveredPlane).toBe('xz');
    expect(fillOpacity(group, 'xz')).toBeGreaterThan(rest);
    expect(fillOpacity(group, 'xy')).toBe(rest);

    expect(quads.setHover(null)).toBe(true);
    expect(quads.hoveredPlane).toBeNull();
    expect(fillOpacity(group, 'xz')).toBe(rest);
  });

  it('only a shown quad can be hovered, and a quad narrowed away drops its hover', () => {
    const { quads, scene, group } = shown();
    const rest = fillOpacity(group, 'xz');
    quads.setHover('xz');

    quads.show(scene, null, ['xy']);
    expect(quads.hoveredPlane).toBeNull();
    expect(fillOpacity(group, 'xz')).toBe(rest);
    // Hidden: hover requests on it read as no hover.
    expect(quads.setHover('xz')).toBe(false);
    expect(quads.hoveredPlane).toBeNull();
    // A quad that stays keeps hovering.
    expect(quads.setHover('xy')).toBe(true);
    quads.show(scene, null, ['xy', 'yz']);
    expect(quads.hoveredPlane).toBe('xy');

    quads.hide();
    expect(quads.hoveredPlane).toBeNull();
    expect(quads.setHover('xy')).toBe(false);
  });
});
