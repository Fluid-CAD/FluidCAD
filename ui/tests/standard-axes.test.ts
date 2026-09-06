// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Box3, BufferAttribute, Line, Object3D, Raycaster, Scene, Vector3 } from 'three';
import { StandardAxes } from '../src/scene/standard-axes';
import { themeColors } from '../src/scene/theme-colors';
import { worldFromMm } from '../src/units/scene-scale';

// The world axes an armed axis slot shows as pick targets: sized past the
// scene, raycastable by axis id, hover/selected tints, and gone on hide.

function shown(bounds: Box3 | null = null): { axes: StandardAxes; scene: Scene; group: Object3D } {
  const scene = new Scene();
  const axes = new StandardAxes();
  axes.show(scene, bounds);
  scene.updateMatrixWorld(true);
  const group = scene.getObjectByName('standardAxes')!;
  return { axes, scene, group };
}

function lineFor(axes: StandardAxes, id: 'x' | 'y' | 'z'): Line {
  return axes.pickTargets.find(l => axes.axisIdFor(l) === id)!;
}

/** The line's end points along its own axis, read off the geometry. */
function extent(axes: StandardAxes, id: 'x' | 'y' | 'z'): [number, number] {
  const position = lineFor(axes, id).geometry.getAttribute('position') as BufferAttribute;
  const component = { x: 0, y: 1, z: 2 }[id];
  return [position.getComponent(0, component), position.getComponent(1, component)];
}

describe('StandardAxes', () => {
  it('is hidden until shown and offers three pick targets while visible', () => {
    const axes = new StandardAxes();
    expect(axes.visible).toBe(false);
    expect(axes.pickTargets).toEqual([]);

    const scene = new Scene();
    axes.show(scene, null);
    expect(axes.visible).toBe(true);
    expect(axes.pickTargets.map(l => axes.axisIdFor(l)).sort()).toEqual(['x', 'y', 'z']);
    expect(axes.axisIdFor(new Object3D())).toBeNull();

    axes.hide();
    expect(axes.visible).toBe(false);
    expect(axes.pickTargets).toEqual([]);
    expect(scene.getObjectByName('standardAxes')).toBeUndefined();
  });

  it('reaches past the scene bounds, with a default reach on an empty scene', () => {
    const empty = shown(null);
    expect(empty.axes.reach).toBeCloseTo(worldFromMm(50), 9);
    expect(extent(empty.axes, 'x')).toEqual([-empty.axes.reach, empty.axes.reach]);

    const bounds = new Box3(new Vector3(-10, -4, 0), new Vector3(30, 8, 12));
    const sized = shown(bounds);
    // The farthest coordinate from the origin (30) times the margin — in
    // the geometry itself, never a group scale (see the class doc).
    expect(sized.axes.reach).toBeCloseTo(30 * 1.5, 9);
    expect(sized.group.scale.x).toBe(1);
    expect(extent(sized.axes, 'z')).toEqual([-45, 45]);
    expect(extent(sized.axes, 'y')).toEqual([-45, 45]);

    const tiny = shown(new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)));
    expect(tiny.axes.reach).toBeCloseTo(worldFromMm(10), 9);
  });

  it('re-sizes in place when shown again over a changed scene', () => {
    const { axes, scene, group } = shown(new Box3(new Vector3(0, 0, 0), new Vector3(20, 0, 0)));
    expect(axes.reach).toBeCloseTo(30, 9);
    axes.show(scene, new Box3(new Vector3(0, 0, 0), new Vector3(40, 0, 0)));
    expect(scene.getObjectByName('standardAxes')).toBe(group);
    expect(axes.reach).toBeCloseTo(60, 9);
    expect(extent(axes, 'x')).toEqual([-60, 60]);
  });

  it('keeps scene furniture out of camera fits', () => {
    const { group } = shown();
    expect(group.userData.isMetaShape).toBe(true);
  });

  it('raycasts to the axis under the cursor, in both directions', () => {
    const { axes } = shown(new Box3(new Vector3(-50, -50, -50), new Vector3(50, 50, 50)));
    const raycaster = new Raycaster();
    raycaster.params.Line = { threshold: 0.5 };

    raycaster.set(new Vector3(5, 0.1, 10), new Vector3(0, 0, -1));
    let hits = raycaster.intersectObjects(axes.pickTargets, false);
    // Only the X axis is within the threshold — the Z axis is 5 units off.
    expect(hits.map(h => axes.axisIdFor(h.object))).toEqual(['x']);
    expect(hits[0].point.x).toBeCloseTo(5, 6);
    expect(hits[0].point.y).toBeCloseTo(0, 6);

    // The negative side is a target too (the old axes helper only drew +).
    raycaster.set(new Vector3(0.1, -20, 10), new Vector3(0, 0, -1));
    hits = raycaster.intersectObjects(axes.pickTargets, false);
    expect(axes.axisIdFor(hits[0].object)).toBe('y');
    expect(hits[0].point.y).toBeCloseTo(-20, 6);

    // Far off every axis: nothing.
    raycaster.set(new Vector3(20, 20, 10), new Vector3(0, 0, -1));
    expect(raycaster.intersectObjects(axes.pickTargets, false)).toEqual([]);
  });

  it('keeps the raycast targets hidden behind the visible fat lines', () => {
    const { axes, group } = shown();
    for (const line of axes.pickTargets) {
      expect(line.visible).toBe(false);
    }
    // One visible fat line per axis, sized like its pick line.
    const visuals = group.children.filter(c => c.visible && axes.axisIdFor(c) !== null);
    expect(visuals.length).toBe(3);
    expect(axes.styleOf('x')).toEqual({ linewidth: 1.5, opacity: 0.5, color: 0xd45d5d });
  });

  it('thickens and tints the hovered axis, and reports changes only', () => {
    const { axes } = shown();
    const base = axes.styleOf('x')!;

    expect(axes.setHover('x')).toBe(true);
    expect(axes.setHover('x')).toBe(false);
    const hovered = axes.styleOf('x')!;
    expect(hovered.color).toBe(themeColors.highlightColor.getHex());
    expect(hovered.opacity).toBe(1);
    expect(hovered.linewidth).toBeGreaterThan(base.linewidth);
    // Only the hovered axis changes.
    expect(axes.styleOf('y')).toEqual(base && { ...base, color: 0x5fad63 });

    expect(axes.setHover(null)).toBe(true);
    expect(axes.styleOf('x')).toEqual(base);
  });

  it('tints the selected axes at full strength, in their own colors and resting width', () => {
    const { axes } = shown();
    const base = axes.styleOf('y')!;

    expect(axes.setSelected(['y', 'z'])).toBe(true);
    expect(axes.setSelected(['z', 'y'])).toBe(false);
    expect(axes.styleOf('y')).toEqual({ ...base, opacity: 1 });
    expect(axes.styleOf('z')!.opacity).toBe(1);
    expect(axes.styleOf('x')!.opacity).toBe(base.opacity);

    // Hover wins the color and width while it lasts; the selection keeps the strength.
    axes.setHover('y');
    expect(axes.styleOf('y')!.color).toBe(themeColors.highlightColor.getHex());
    expect(axes.styleOf('y')!.linewidth).toBeGreaterThan(base.linewidth);
    axes.setHover(null);
    expect(axes.styleOf('y')).toEqual({ ...base, opacity: 1 });

    expect(axes.setSelected([])).toBe(true);
    expect(axes.styleOf('y')).toEqual(base);
    expect(axes.styleOf('z')).toEqual({ ...base, color: 0x4f83cc });
  });

  it('drops hover and selection on hide', () => {
    const { axes, scene } = shown();
    axes.setHover('z');
    axes.setSelected(['x']);
    axes.hide();
    axes.show(scene, null);
    for (const id of ['x', 'y', 'z'] as const) {
      expect(axes.styleOf(id)!.opacity).toBeLessThan(1);
      expect(axes.styleOf(id)!.linewidth).toBe(1.5);
    }
  });
});
