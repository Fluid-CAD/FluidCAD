import {
  BufferAttribute,
  BufferGeometry,
  Group,
  LineDashedMaterial,
  LineSegments,
} from 'three';
import { SceneObjectRender } from '../../types';

const AXIS_COLOR = '#c88f40';

export class AxisMesh extends Group {
  constructor(sceneObject: SceneObjectRender) {
    super();

    const meshData = sceneObject.sceneShapes[0]?.meshes[0];
    if (!meshData) return;

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(meshData.vertices), 3));

    const line = new LineSegments(
      geometry,
      new LineDashedMaterial({ color: AXIS_COLOR, dashSize: 5, gapSize: 5 }),
    );
    line.computeLineDistances();

    this.add(line);
  }
}
