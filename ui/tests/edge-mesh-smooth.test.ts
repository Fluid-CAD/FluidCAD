// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Color } from 'three';
import { EdgeMesh } from '../src/meshes/shape-meshes/edge-mesh';
import { themeColors } from '../src/scene/theme-colors';
import type { SceneObjectMesh } from '../src/types';

/**
 * The engine stamps `smooth` on a solid edge whose two faces are tangent
 * there. Such an edge marks no crease, so it is drawn pulled toward the face
 * color instead of in the full edge color; an explicit color option (a
 * selection highlight, a ghost) always wins.
 */
function edgeMeshData(smooth: boolean): SceneObjectMesh {
  return {
    label: 'solid-edges',
    vertices: [0, 0, 0, 10, 0, 0],
    normals: [],
    indices: [0, 1],
    edgeIndex: 3,
    smooth,
  };
}

function materialColor(mesh: EdgeMesh): number {
  const line = mesh.children[0] as unknown as { material: { color: Color } };
  return line.material.color.getHex();
}

describe('EdgeMesh — tangent edges draw dimmed', () => {
  it('draws a plain edge in the edge color', () => {
    const mesh = new EdgeMesh({ shapeType: 'edge', meshes: [edgeMeshData(false)] });
    expect(materialColor(mesh)).toBe(themeColors.edgeColor.getHex());
    expect(mesh.children[0].userData.smoothEdge).toBeUndefined();
  });

  it('pulls a smooth edge toward the face color and tags the line', () => {
    const mesh = new EdgeMesh({ shapeType: 'edge', meshes: [edgeMeshData(true)] });
    const expected = themeColors.edgeColor.clone().lerp(themeColors.faceColor, 0.75).getHex();
    expect(materialColor(mesh)).toBe(expected);
    expect(materialColor(mesh)).not.toBe(themeColors.edgeColor.getHex());
    expect(mesh.children[0].userData.smoothEdge).toBe(true);
    expect(mesh.children[0].userData.edgeIndex).toBe(3);
  });

  it('an explicit color option overrides the dimming', () => {
    const mesh = new EdgeMesh({ shapeType: 'edge', meshes: [edgeMeshData(true)] }, { color: '#ff0000' });
    expect(materialColor(mesh)).toBe(0xff0000);
  });
});
