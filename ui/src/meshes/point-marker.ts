import { CircleGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { applyConstantPixelSize } from './screen-scale';

/** The constant-pixel circle used by sketch previews and viewport point picks. */
export function createPointMarker(
  position: Vector3,
  color: number | string,
  options: { pixelRadius: number; radius?: number; segments?: number; opacity?: number; renderOrder?: number; normal?: Vector3 },
): Group {
  const radius = options.radius ?? 1;
  const opacity = options.opacity ?? 1;
  const order = options.renderOrder ?? 4;
  const dot = new Mesh(new CircleGeometry(radius, options.segments ?? 24), new MeshBasicMaterial({
    color, side: DoubleSide, depthTest: false, depthWrite: false,
    transparent: opacity < 1, opacity,
  }));
  dot.renderOrder = order;
  const group = new Group();
  group.renderOrder = order;
  group.position.copy(position);
  if (options.normal) {
    group.lookAt(position.clone().add(options.normal));
  }
  group.add(dot);
  applyConstantPixelSize(dot, group, group.position, options.pixelRadius, radius);
  return group;
}
