import { Vector2 } from 'three';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

/**
 * Tracks the viewport size that all `LineMaterial` instances render against.
 * Each material owns its own `resolution` Vector2 (LineMaterial copies on
 * assignment rather than sharing a reference), so on resize we have to copy
 * the new size into every live material.
 */
export class LineResolutionRegistry {
  private static resolution = new Vector2(window.innerWidth, window.innerHeight);
  private static materials = new Set<LineMaterial>();

  static register(material: LineMaterial): void {
    material.resolution.copy(LineResolutionRegistry.resolution);
    LineResolutionRegistry.materials.add(material);
    material.addEventListener('dispose', () => {
      LineResolutionRegistry.materials.delete(material);
    });
  }

  static setResolution(width: number, height: number): void {
    LineResolutionRegistry.resolution.set(width, height);
    for (const m of LineResolutionRegistry.materials) {
      m.resolution.copy(LineResolutionRegistry.resolution);
    }
  }
}
