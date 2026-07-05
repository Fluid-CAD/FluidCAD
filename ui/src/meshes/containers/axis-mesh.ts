import {
  BufferAttribute,
  BufferGeometry,
  Group,
  LineDashedMaterial,
  LineSegments,
} from 'three';
import { SceneObjectRender } from '../../types';
import { trackPixelsPerWorld } from '../screen-scale';

const AXIS_COLOR = '#c88f40';

// Axis dash pattern (in screen pixels)
const AXIS_DASH_PX = 12;
const AXIS_GAP_PX = 12;

export class AxisMesh extends Group {
  constructor(sceneObject: SceneObjectRender) {
    super();

    const meshData = sceneObject.sceneShapes[0]?.meshes[0];
    if (!meshData) return;

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(meshData.vertices), 3));

    const material = new LineDashedMaterial({
      color: AXIS_COLOR,
      dashSize: AXIS_DASH_PX,
      gapSize: AXIS_GAP_PX,
    });
    const line = new LineSegments(geometry, material);
    line.computeLineDistances();
    trackPixelsPerWorld(line, (pixelsPerWorld) => {
      material.scale = pixelsPerWorld;
    });

    this.add(line);
  }
}
