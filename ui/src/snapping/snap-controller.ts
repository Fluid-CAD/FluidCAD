import { Vector3 } from 'three';
import { SnapManager } from './snap-manager';
import { SnapResult } from './types';
import { PlaneData } from '../types';

/**
 * Reusable snap controller that wraps a SnapManager with toggle state.
 * Any interactive mode can use this to apply snapping with user-controlled
 * vertex and grid snap toggles.
 */
export class SnapController {
  private snapManager: SnapManager;
  private plane: PlaneData;

  snapToVertices = true;
  snapToGrid = true;

  constructor(snapManager: SnapManager, plane: PlaneData) {
    this.snapManager = snapManager;
    this.plane = plane;
  }

  updateSnapManager(snapManager: SnapManager): void {
    this.snapManager = snapManager;
  }

  /**
   * Snap a 2D sketch point according to current toggle state.
   * Returns the (possibly snapped) result with snap type info.
   */
  snap(point2d: [number, number]): SnapResult {
    if (!this.snapToVertices && !this.snapToGrid) {
      return this.noSnapResult(point2d);
    }

    const result = this.snapManager.snap(point2d, this.plane);

    if (result.snapType === 'vertex' && !this.snapToVertices) {
      return this.noSnapResult(point2d);
    }
    if (result.snapType === 'grid' && !this.snapToGrid) {
      return this.noSnapResult(point2d);
    }

    return result;
  }

  private noSnapResult(point2d: [number, number]): SnapResult {
    const o = this.plane.origin;
    const x = this.plane.xDirection;
    const y = this.plane.yDirection;
    return {
      point2d,
      worldPoint: new Vector3(
        o.x + x.x * point2d[0] + y.x * point2d[1],
        o.y + x.y * point2d[0] + y.y * point2d[1],
        o.z + x.z * point2d[0] + y.z * point2d[1],
      ),
      snapType: 'none',
    };
  }
}
