import { Group, Object3D } from 'three';
import { SketchRegionEntry } from '../../api';
import { RegionMetaFaceMesh } from '../../meshes/shape-meshes/region-meta-face-mesh';
import { Viewer } from '../../viewer';
import { disposeTree } from './feature-ghost';

/**
 * The region picker's faces, drawn over the profile while a feature dialog
 * picks regions: one translucent face per closed region of the sketch, the
 * picked ones a shade stronger. The meshes come from the server's side
 * channel (`/api/sketch-regions`) — never scene shapes, nothing anything
 * else can pick — and sit in a group that is a sibling of `compiledMesh`,
 * so a render never tears them down and the auto-fit ignores them (the
 * feature ghost's arrangement, for the same reasons).
 */
export class RegionPickOverlay {
  private group = new Group();

  constructor(private viewer: Viewer) {
    this.group.name = 'regionPick';
    this.group.userData.isMetaShape = true;
    this.group.renderOrder = 3;
    this.viewer.sceneContext.scene.add(this.group);
  }

  /** The group the pick mode raycasts — this overlay's faces and nothing else. */
  get root(): Object3D {
    return this.group;
  }

  /** Replace the drawn regions; an empty list just clears. */
  set(regions: SketchRegionEntry[]): void {
    this.clear();
    for (const region of regions) {
      this.group.add(new RegionMetaFaceMesh({
        shapeType: 'face',
        isMetaShape: true,
        meshes: region.meshes,
        metaData: { key: region.key, index: region.index },
      }, region.selected));
    }
    // Pick candidates are filtered per node, not per subtree — tag the faces
    // too, so the overlay never intercepts a geometry pick.
    this.group.traverse(node => { node.userData.isMetaShape = true; });
    this.viewer.sceneContext.requestRender();
  }

  /** Drop the drawn regions and free their GPU resources. */
  clear(): void {
    if (this.group.children.length === 0) {
      return;
    }
    while (this.group.children.length > 0) {
      const child = this.group.children[0];
      this.group.remove(child);
      disposeTree(child);
    }
    this.viewer.sceneContext.requestRender();
  }
}
