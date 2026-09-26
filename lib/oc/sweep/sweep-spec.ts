import type { TopoDS_Vertex } from "ocjs-fluidcad";
import type { Face } from "../../common/face.js";
import type { Wire } from "../../common/wire.js";
import type { Vector3d } from "../../math/vector3d.js";
import type { Matrix4 } from "../../math/matrix4.js";
import type { Point } from "../../math/point.js";
import type { Plane } from "../../math/plane.js";
import type { ResolvedHelixGeometry } from "../../math/helix-geometry.js";
import { SpineAnalysis } from "./spine-analysis.js";
import { placeCylindricalProfile } from "./helix-placement.js";
import { resolveSweepTolerances, type SweepTolerancePolicy } from "./tolerances.js";

export type { SweepTolerancePolicy } from "./tolerances.js";

/** Kernel transport laws; true Frenet and corrected Frenet are distinct. */
export type SweepTransport =
  | { kind: "binormal"; axis: Vector3d }
  | { kind: "helix"; geometry: ResolvedHelixGeometry }
  | { kind: "frenet" }
  | { kind: "correctedFrenet" };

/**
 * Placement is independent of transport. Legacy localization/correction is
 * explicitly named until station and alignment resolution replace it. A
 * resolved vertex preserves the drawn offset with contact/correction off.
 */
export type SweepPlacement =
  | { kind: "legacyAutomatic"; withCorrection: boolean }
  | { kind: "atVertex"; vertex: TopoDS_Vertex }
  | { kind: "atStart"; transform: Matrix4; station: Point };

export interface ResolvedSweepSpec {
  readonly spine: SpineAnalysis;
  readonly profileFaces: readonly Face[];
  readonly transport: SweepTransport;
  readonly placement: SweepPlacement;
  readonly tolerances: SweepTolerancePolicy;
}

/**
 * Shared by commit and ghost through SweepOps. Authored cylindrical paths
 * use their exact axis, independent of pitch, winding and sample count.
 * Explicit options are internal qualification hooks, not public API controls.
 */
export function resolveSweepSpec(
  wire: Wire,
  profileFaces: readonly Face[],
  options: { transport?: SweepTransport; placement?: SweepPlacement; profilePlane?: Plane } = {},
): ResolvedSweepSpec {
  if (profileFaces.length === 0) {
    throw new Error("Could not extract profile faces from extrudable.");
  }
  const spine = new SpineAnalysis(wire);
  const plane = options.profilePlane ?? profileFaces[0].getPlane();
  const descriptors = spine.edges.map(edge => wire.getHelixEdges().find(entry => entry.edge.IsSame(edge.edge))?.geometry);
  const helixIndex = descriptors.findIndex(Boolean);
  const geometry = descriptors[helixIndex];
  // One authored helix, optionally continued by tangent lines. Tapers retain
  // the approximate axis-binormal transport and legacy placement until their
  // separate qualification; do not advertise that as exact screw motion.
  const helixRun = geometry && !spine.hasCorners
    && spine.edges.every((edge, i) => i === helixIndex || (edge.isLine && !descriptors[i]));
  const cylindrical = helixRun && geometry.startRadius === geometry.endRadius;
  const transport = options.transport ?? (cylindrical
    ? { kind: "helix" as const, geometry }
    : helixRun ? { kind: "binormal" as const, axis: geometry.frame.mainDirection } : spine.trihedron(plane));
  const placement = options.placement ?? (transport.kind === "helix" && cylindrical ? {
    kind: "atStart" as const, ...placeCylindricalProfile(spine, helixIndex, geometry, plane, profileFaces),
  } : {
    kind: "legacyAutomatic",
    withCorrection: plane.normal.dot(spine.startTangent) >= -0.999,
  });
  // Corner overshoots change the run's vertices. Do not silently discard an
  // explicit station until the corner builder can carry it through its joins.
  if (spine.hasCorners && placement.kind !== "legacyAutomatic") {
    throw new Error("Explicit sweep stations are currently supported only on smooth paths.");
  }
  return {
    spine, profileFaces: [...profileFaces], placement,
    transport,
    tolerances: resolveSweepTolerances(),
  };
}
