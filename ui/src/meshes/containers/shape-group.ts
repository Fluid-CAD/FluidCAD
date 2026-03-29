import { Group } from 'three';
import { EdgeMeshOptions, MeshRenderOptions, SceneObjectPart, SceneObjectRender } from '../../types';
import { EdgeMesh } from '../shape-meshes/edge-mesh';
import { FaceMesh } from '../shape-meshes/face-mesh';
import { SolidMesh } from '../shape-meshes/solid-mesh';
import { MetaEdgeMesh } from '../shape-meshes/meta-edge-mesh';
import { TrimMetaEdgeMesh } from '../shape-meshes/trim-meta-edge-mesh';
import { RegionMetaFaceMesh } from '../shape-meshes/region-meta-face-mesh';
import { PickEdgeMesh } from '../shape-meshes/pick-edge-mesh';

const STANDALONE_EDGE_STYLE: EdgeMeshOptions = { color: '#2297ff', lineWidth: 2 };

/** Map of metaType → factory function. Falls back to MetaEdgeMesh. */
const metaEdgeFactories: Record<string, (shape: SceneObjectPart) => Group> = {
  trim: (shape) => new TrimMetaEdgeMesh(shape),
  'pick-edge': (shape) => new PickEdgeMesh(shape),
};

export function createMetaEdgeMesh(shape: SceneObjectPart): Group {
  const factory = shape.metaType ? metaEdgeFactories[shape.metaType] : undefined;
  return factory ? factory(shape) : new MetaEdgeMesh(shape);
}

/** Map of metaType → factory function for face meta shapes. */
const metaFaceFactories: Record<string, (shape: SceneObjectPart) => Group> = {
  'pick-region': (shape) => new RegionMetaFaceMesh(shape, false),
  'pick-region-selected': (shape) => new RegionMetaFaceMesh(shape, true),
};

export function createMetaFaceMesh(shape: SceneObjectPart): Group {
  const factory = shape.metaType ? metaFaceFactories[shape.metaType] : undefined;
  return factory ? factory(shape) : new FaceMesh(shape);
}

/**
 * Builds the Three.js geometry for a leaf scene object — one that has no
 * children and whose `sceneShapes` contain the actual vertex / index data.
 *
 * Each shape part is dispatched to the appropriate low-level mesh class
 * based on its `shapeType`.
 */
export class ShapeGroup extends Group {
  constructor(
    sceneObject: SceneObjectRender,
    options?: MeshRenderOptions,
  ) {
    super();

    if (!sceneObject.sceneShapes) {
      return;
    }

    // Check if this object contains only wire/edge shapes (no face or solid).
    const isStandaloneWireEdge = sceneObject.sceneShapes.every(
      s => s.isMetaShape || s.shapeType === 'wire' || s.shapeType === 'edge',
    );

    for (const shape of sceneObject.sceneShapes) {
      let mesh: Group | undefined;

      if (shape.isMetaShape) {
        switch (shape.shapeType) {
          case 'wire':
          case 'edge':
            mesh = createMetaEdgeMesh(shape);
            break;
          case 'face':
            mesh = createMetaFaceMesh(shape);
            break;
        }
      } else {
        switch (shape.shapeType) {
          case 'wire':
          case 'edge': {
            const edgeOpts = options?.edge
              ?? (isStandaloneWireEdge ? STANDALONE_EDGE_STYLE : undefined);
            mesh = new EdgeMesh(shape, edgeOpts);
            break;
          }
          case 'face':
            mesh = new FaceMesh(shape, options?.face);
            break;
          case 'solid':
            mesh = new SolidMesh(shape, options);
            break;
        }
      }

      if (mesh) {
        if (shape.shapeId) {
          mesh.userData.shapeId = shape.shapeId;
        }
        this.add(mesh);
      }
    }
  }
}
