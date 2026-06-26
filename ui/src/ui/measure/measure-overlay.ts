import { BufferGeometry, Float32BufferAttribute, Group, Points, PointsMaterial } from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineResolutionRegistry } from '../../meshes/shape-meshes/line-resolution';
import { themeColors } from '../../scene/theme-colors';
import type { SceneContext } from '../../scene/scene-context';
import type { MeasureVec } from '../../api';

export type MeasureAxis = 'x' | 'y' | 'z';

export type MeasureViz = {
  from: MeasureVec;
  to: MeasureVec;
  axis?: MeasureAxis;
};

const AXIS_COLORS: Record<MeasureAxis, number> = {
  x: 0xe5484d,
  y: 0x30a46c,
  z: 0x3e63dd,
};

const OVERLAY_RENDER_ORDER = 999;

/**
 * Draws measurement lines in the viewport: the distance segment between the
 * two realizing points, and — when an axis is given — the right-triangle
 * decomposition with the hovered axis leg highlighted in that axis color.
 */
export class MeasureOverlay {
  private group: Group | null = null;

  constructor(private ctx: SceneContext) {}

  show(viz: MeasureViz): void {
    this.clear();
    const { from, to, axis } = viz;
    if (dist2(from, to) < 1e-12) {
      return;
    }

    const group = new Group();
    group.name = 'measureOverlay';
    group.userData.isMetaShape = true;

    group.add(this.makeLine(from, to, themeColors.highlightColor.getHex(), { width: 2.5 }));

    if (axis) {
      const corner = {
        x: axis === 'x' ? to.x : from.x,
        y: axis === 'y' ? to.y : from.y,
        z: axis === 'z' ? to.z : from.z,
      };
      if (dist2(from, corner) > 1e-12) {
        group.add(this.makeLine(from, corner, AXIS_COLORS[axis], { width: 3.5 }));
      }
      if (dist2(corner, to) > 1e-12) {
        group.add(this.makeLine(corner, to, themeColors.metaEdgeColor.getHex(), { width: 1.5, dashed: true }));
      }
      group.add(this.makePoints([from, to, corner]));
    } else {
      group.add(this.makePoints([from, to]));
    }

    group.traverse((child) => {
      child.userData.isMetaShape = true;
      child.renderOrder = OVERLAY_RENDER_ORDER;
    });

    this.group = group;
    this.ctx.scene.add(group);
    this.ctx.requestRender();
  }

  clear(): void {
    if (!this.group) {
      return;
    }
    this.group.traverse((child: any) => {
      child.geometry?.dispose();
      child.material?.dispose();
    });
    this.group.parent?.remove(this.group);
    this.group = null;
    this.ctx.requestRender();
  }

  private makeLine(
    from: MeasureVec,
    to: MeasureVec,
    color: number,
    opts: { width: number; dashed?: boolean },
  ): Line2 {
    const geometry = new LineGeometry();
    geometry.setPositions([from.x, from.y, from.z, to.x, to.y, to.z]);

    const segmentLength = Math.sqrt(dist2(from, to));
    const material = new LineMaterial({
      color,
      linewidth: opts.width,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      dashed: !!opts.dashed,
      dashSize: segmentLength / 16,
      gapSize: segmentLength / 24,
    });
    LineResolutionRegistry.register(material);

    const line = new Line2(geometry, material);
    if (opts.dashed) {
      line.computeLineDistances();
    }
    return line;
  }

  private makePoints(points: MeasureVec[]): Points {
    const geometry = new BufferGeometry();
    const positions = points.flatMap((p) => [p.x, p.y, p.z]);
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));

    const material = new PointsMaterial({
      color: themeColors.highlightColor.getHex(),
      size: 7,
      sizeAttenuation: false,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    return new Points(geometry, material);
  }
}

function dist2(a: MeasureVec, b: MeasureVec): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
