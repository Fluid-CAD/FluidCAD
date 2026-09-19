import { Group, Vector3 } from 'three';
import type { GhostSolid } from '../../api';
import { EdgeMesh } from '../../meshes/shape-meshes/edge-mesh';
import { onThemeChange, themeColors } from '../../scene/theme-colors';
import { worldFromMm } from '../../units/scene-scale';
import type { Viewer } from '../../viewer';
import { disposeTree } from './feature-ghost';
import type { ConnectionPoint, ConnectionRow } from './loft-connections';

/** True side-edge matching, plus the unfinished row's straight point segments. */
export class LoftConnectionsOverlay {
  private group = new Group();
  private lines: number[][] = [];
  private rows: ConnectionRow[] = [];
  private active: number | null = null;
  private visible = false;
  private readonly removeThemeListener: () => void;

  constructor(private viewer: Viewer) {
    this.group.name = 'loft-connections';
    this.group.userData.isMetaShape = true;
    viewer.sceneContext.scene.add(this.group);
    this.removeThemeListener = onThemeChange(() => {
      if (this.visible) {
        this.draw();
      }
    });
  }

  dispose(): void {
    this.removeThemeListener();
    this.clear();
    this.group.removeFromParent();
  }

  setGhost(solids: GhostSolid[] | null): void {
    this.lines = solids?.flatMap(solid => solid.matchLines ?? []) ?? [];
    this.draw();
  }

  set(rows: ConnectionRow[], active: number | null, visible: boolean): void {
    this.rows = rows;
    this.active = active;
    this.visible = visible;
    this.draw();
  }

  clear(): void {
    for (const child of [...this.group.children]) {
      child.removeFromParent();
      disposeTree(child);
    }
    this.viewer.sceneContext.requestRender();
  }

  private draw(): void {
    this.clear();
    if (!this.visible) {
      return;
    }
    const covered = new Set<string>();
    for (const line of this.lines) {
      const match = this.rows.map(row => LoftConnectionsOverlay.matchedSpan(line, row)).findIndex(span => span !== null);
      if (match >= 0) {
        const [start, end] = LoftConnectionsOverlay.matchedSpan(line, this.rows[match])!;
        for (let i = start; i < end; i++) {
          covered.add(`${match}:${i}`);
        }
      }
      this.addLine(line, match < 0 ? null : match);
    }
    this.rows.forEach((row, index) => {
      for (let i = 0; i + 1 < row.points.length; i++) {
        const a = row.points[i]?.point;
        const b = row.points[i + 1]?.point;
        if (a && b && !covered.has(`${index}:${i}`)) {
          this.addLine([...a, ...b], index);
        }
      }
    });
  }

  private addLine(vertices: number[], row: number | null): void {
    if (vertices.length < 6) {
      return;
    }
    const indices: number[] = [];
    for (let i = 0; i + 1 < vertices.length / 3; i++) {
      indices.push(i, i + 1);
    }
    const mesh = new EdgeMesh({ meshes: [{ vertices, indices, normals: [] }] }, {
      color: `#${themeColors.loftMatchColor.getHexString()}`,
      lineWidth: row === null ? 1.5 : row === this.active ? 3 : 2.5,
      opacity: row === null ? 0.65 : 1,
      depthWrite: false,
    });
    mesh.userData.connectionRow = row;
    mesh.traverse(node => { node.renderOrder = 5; });
    this.group.add(mesh);
  }

  /** A kernel edge can span all profiles or one interval between them. */
  static matchedSpan(line: number[], row: ConnectionRow): [number, number] | null {
    if (line.length < 6) {
      return null;
    }
    const at = (offset: number) => row.points.findIndex(slot =>
      slot?.point && LoftConnectionsOverlay.near(slot.point, line.slice(offset, offset + 3)));
    const a = at(0);
    const b = at(line.length - 3);
    return a < 0 || b < 0 || a === b ? null : [Math.min(a, b), Math.max(a, b)];
  }

  private static near(a: ConnectionPoint, b: number[]): boolean {
    return new Vector3(...a).distanceToSquared(new Vector3(b[0], b[1], b[2])) <= worldFromMm(1e-3) ** 2;
  }
}
