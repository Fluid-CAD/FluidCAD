import { Group } from 'three';
import { EdgeMeshOptions, MeshRenderOptions, SceneObjectPart, SceneObjectRender } from '../../types';
import { EdgeMesh } from '../shape-meshes/edge-mesh';
import { FaceMesh } from '../shape-meshes/face-mesh';
import { BodyMesh } from '../shape-meshes/body-mesh';
import { MetaEdgeMesh, MetaEdgeOptions } from '../shape-meshes/meta-edge-mesh';
import { RegionMetaFaceMesh } from '../shape-meshes/region-meta-face-mesh';
import { PickEdgeMesh } from '../shape-meshes/pick-edge-mesh';

const STANDALONE_EDGE_STYLE: EdgeMeshOptions = { color: '#2297ff', lineWidth: 2 };

/** Map of metaType → factory function. Falls back to MetaEdgeMesh. */
const metaEdgeFactories: Record<string, (shape: SceneObjectPart) => Group> = {
  'pick-edge': (shape) => new PickEdgeMesh(shape),
};

/** `options` style the default dash-dot (a sketch's guides); typed meta edges ignore them. */
export function createMetaEdgeMesh(shape: SceneObjectPart, options?: MetaEdgeOptions): Group {
  const factory = shape.metaType ? metaEdgeFactories[shape.metaType] : undefined;
  return factory ? factory(shape) : new MetaEdgeMesh(shape, options);
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
    isRegionPicking: boolean,
    options?: MeshRenderOptions,
  ) {
    super();

    if (!sceneObject.sceneShapes) {
      return;
    }

    // Check if this object contains only wire/edge shapes (no face or body).
    const isStandaloneWireEdge = sceneObject.sceneShapes.every(
      s => s.isMetaShape || s.shapeType === 'wire' || s.shapeType === 'edge',
    );

    const PICK_META_TYPES = ['pick-region', 'pick-region-selected', 'pick-edge'];

    for (const shape of sceneObject.sceneShapes) {
      // Skip pick-region meta shapes when not in region picking mode
      if (!isRegionPicking && shape.isMetaShape && shape.metaType && PICK_META_TYPES.includes(shape.metaType)) {
        continue;
      }

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
            // A wire serializes one line per edge, each with its edge index,
            // so every edge of a curve picks on its own. A bare single-edge
            // shape (a helix) serializes without one (renderEdge), which
            // keeps it out of the edge pick bucket. It IS exactly one edge,
            // so give its lines the pick identity {edge, 0} — that is what
            // makes a helix clickable in the viewport.
            if (shape.shapeType === 'edge') {
              mesh.traverse(child => {
                if (child.userData.isEdgeLine && child.userData.edgeIndex === undefined) {
                  child.userData.edgeIndex = 0;
                }
              });
            }
            break;
          }
          case 'face':
            mesh = new FaceMesh(shape, options?.face);
            break;
          case 'solid':
            mesh = new BodyMesh(shape, options);
            break;
          case 'sheet':
            mesh = new BodyMesh(shape, { ...options, body: 'sheet' });
            break;
        }
      }

      if (mesh) {
        if (shape.shapeId) {
          mesh.userData.shapeId = shape.shapeId;
        }
        if (!shape.isMetaShape && !shape.isGuide && shape.vertices) {
          mesh.userData.topologyVertices = shape.vertices;
        }
        this.add(mesh);
      }
    }
  }
}
