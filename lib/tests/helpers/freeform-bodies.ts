import { sketch, line, spline, circle, ellipse, extrude, fillet, shell, revolve, loft, plane } from "../../core/index.js";
import { Extrude } from "../../features/extrude.js";

/**
 * Bodies whose faces lie on B-spline, offset, revolved and extruded surfaces,
 * built by the features that leave them in real models. Each adds its
 * features to the current scene; the test renders.
 */
export const FreeformBodies = {
  /**
   * A 40 × 20 × 10 slab bounded by a line and three splines, its corner at
   * `at`, its top edges filleted by 1.5 and its bottom edges by 1: the six
   * fillets along the splines lie on B-spline surfaces, the walls on
   * extruded ones.
   */
  filletedSlab(at: [number, number] = [0, 0]): Extrude {
    const slab = splineSlab(at);
    fillet(1.5, slab.endEdges());
    fillet(1, slab.startEdges());
    return slab;
  },

  /** {@link filletedSlab} before its fillets: a flat wall facing -y and three extruded ones facing +x, +y and -x. */
  splineSlab(at: [number, number] = [0, 0]): Extrude {
    return splineSlab(at);
  },

  /** {@link filletedSlab} without its bottom fillets, hollowed from below: the inside of each top fillet is an offset surface. */
  shelledSlab(): void {
    const slab = splineSlab([0, 0]);
    fillet(1.5, slab.endEdges());
    shell(0.4, slab.startFaces());
  },

  /** A loft from a Ø40 circle at z = `z` to a 10 × 18 ellipse 30 above it: one B-spline wall between two flat ends. */
  ellipseLoft(z = 0): void {
    const base = sketch(plane("xy", z), () => {
      circle([0, 0], 40);
    });
    const top = sketch(plane("xy", z + 30), () => {
      ellipse([0, 0], 5, 9);
    });
    loft(base, top);
  },

  /** A spline profile `offset` from the z axis turned 100° about it: one revolved wall. */
  revolvedSpline(offset = 100): void {
    sketch("xz", () => {
      line([offset, 0], [offset + 10, 0]);
      spline([offset + 10, 0], [offset + 17.3, 3.1], [offset + 9, 10], [offset + 13, 15]);
      line([offset + 13, 15], [offset, 15]);
      line([offset, 15], [offset, 0]);
    });
    revolve("z", 100);
  },
};

function splineSlab([x, y]: [number, number]): Extrude {
  sketch("xy", () => {
    line([x, y], [x + 40, y]);
    spline([x + 40, y], [x + 46, y + 7], [x + 38, y + 14], [x + 40, y + 20]);
    spline([x + 40, y + 20], [x + 26, y + 26], [x + 14, y + 16], [x, y + 20]);
    spline([x, y + 20], [x - 5, y + 12], [x + 4, y + 6], [x, y]);
  });
  return extrude(10) as Extrude;
}
