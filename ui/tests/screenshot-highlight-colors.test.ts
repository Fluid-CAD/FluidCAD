// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshBasicMaterial, Scene } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { ScreenshotHighlightOverlay } from '../src/screenshot-overlays';
import { themeColors } from '../src/scene/theme-colors';

// A capture's highlight entries each in their own colour (§11.2): the chat's
// scene references draw [1] red, [2] blue, … in one picture. An entry
// without a colour keeps the theme's highlight colour and the translucent
// fill.

/** One shape: a two-triangle quad (faces 0 and 1) and one edge line (edge 0). */
function shape(shapeId: string): Group {
  const group = new Group();
  group.userData.shapeId = shapeId;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const faces = new Mesh(geometry, new MeshBasicMaterial());
  faces.userData.faceMapping = [0, 1];
  const lineGeometry = new LineSegmentsGeometry();
  lineGeometry.setPositions([0, 0, 0, 10, 0, 0]);
  const edge = new LineSegments2(lineGeometry);
  edge.userData.isEdgeLine = true;
  edge.userData.edgeIndex = 0;
  group.add(faces, edge);
  return group;
}

function overlays(scene: Scene): { faces: Mesh[]; edges: LineSegments2[] } {
  const faces: Mesh[] = [];
  const edges: LineSegments2[] = [];
  scene.traverse((obj) => {
    if (obj.renderOrder < ScreenshotHighlightOverlay.RENDER_ORDER) {
      return;
    }
    if ((obj as LineSegments2).isLineSegments2) {
      edges.push(obj as LineSegments2);
    } else if ((obj as Mesh).isMesh) {
      faces.push(obj as Mesh);
    }
  });
  return { faces, edges };
}

describe('ScreenshotHighlightOverlay colours', () => {
  it('draws each entry in its own colour, faces nearly opaque', () => {
    const scene = new Scene();
    scene.add(shape('s1'));
    const overlay = ScreenshotHighlightOverlay.build(scene, [
      { shapeId: 's1', kind: 'edge', index: 0, color: '#e5484d' },
      { shapeId: 's1', kind: 'face', index: 1, color: '#2f6ff0' },
      { shapeId: 's1', kind: 'face', index: 0 },
    ]);
    const { faces, edges } = overlays(scene);
    expect(edges).toHaveLength(1);
    expect((edges[0].material as LineMaterial).color.getHex()).toBe(new Color('#e5484d').getHex());

    expect(faces).toHaveLength(2);
    const [blue, plain] = faces.map((m) => m.material as MeshBasicMaterial);
    expect(blue.color.getHex()).toBe(new Color('#2f6ff0').getHex());
    expect(blue.opacity).toBe(ScreenshotHighlightOverlay.COLORED_FACE_OPACITY);
    expect(ScreenshotHighlightOverlay.COLORED_FACE_OPACITY).toBeCloseTo(0.85);
    // Without a colour: the theme's highlight, translucent as before.
    expect(plain.color.getHex()).toBe(themeColors.highlightColor.getHex());
    expect(plain.opacity).toBe(ScreenshotHighlightOverlay.FACE_OPACITY);
    // Faces and edges still show through occluders.
    expect(blue.depthTest).toBe(false);
    expect(overlay.bounds.isEmpty()).toBe(false);

    overlay.dispose();
    expect(overlays(scene).faces).toHaveLength(0);
  });

  it('treats a colour that is not a CSS hex as none', () => {
    expect(ScreenshotHighlightOverlay.parseColor('#abc')?.getHex()).toBe(new Color('#aabbcc').getHex());
    expect(ScreenshotHighlightOverlay.parseColor('red')).toBeNull();
    expect(ScreenshotHighlightOverlay.parseColor(undefined)).toBeNull();
    const scene = new Scene();
    scene.add(shape('s1'));
    ScreenshotHighlightOverlay.build(scene, [{ shapeId: 's1', kind: 'edge', index: 0, color: 'url(x)' }]);
    expect((overlays(scene).edges[0].material as LineMaterial).color.getHex()).toBe(themeColors.highlightColor.getHex());
  });
});
