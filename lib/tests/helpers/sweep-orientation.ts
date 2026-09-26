import type { TopoDS_Shape } from "ocjs-fluidcad";
import { buildResolvedHelixEdge, resolveHelixGeometry } from "../../features/helix-geometry.js";
import { CoordinateSystem } from "../../math/coordinate-system.js";
import { Matrix4 } from "../../math/matrix4.js";
import { Plane } from "../../math/plane.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { Explorer } from "../../oc/explorer.js";
import { FaceOps } from "../../oc/face-ops.js";
import { getOC } from "../../oc/init.js";
import { PipeRun } from "../../oc/sweep/pipe-run.js";
import { resolveSweepSpec, type ResolvedSweepSpec } from "../../oc/sweep/sweep-spec.js";
import { WireOps } from "../../oc/wire-ops.js";

export const TRAPEZOID: [number, number][] = [
  [2.5, -4], [-2.5, -4], [-2.5 + 5 * Math.tan(Math.PI / 12), 1],
  [2.5 - 5 * Math.tan(Math.PI / 12), 1],
];
export const SECTION_TOLERANCE = 1e-3;
export const ROLL_TOLERANCE_DEG = 0.01;

/** Solved vertices bypass the sketch solver; dimensions match the open model. */
export function orientationFixture(
  pitch = 28,
  turns = 5,
  ccw = false,
  frame = new CoordinateSystem(Point.origin(), Vector3d.unitZ(), Vector3d.unitX()),
  scale = 1,
) {
  const geometry = resolveHelixGeometry({
    kind: "cylinder-face", cs: frame, radius: 25 * scale, vMin: 0, vMax: pitch * turns,
  }, { turns, startOffset: -10 * scale, endOffset: -10 * scale, ccw });
  const edge = buildResolvedHelixEdge(geometry);
  const wire = WireOps.makeWireFromEdges([edge]);
  const tangent = EdgeOps.getEdgeTangentAtStartRaw(edge.getShape());
  const origin = EdgeOps.getVertexPointRaw(EdgeOps.getFirstVertexRaw(edge.getShape()));
  const plane = new Plane(origin, frame.xDirection.cross(tangent).normalize(), tangent.negate());
  const points = TRAPEZOID.map(([u, v]) =>
    origin.add(plane.xDirection.multiply(u * scale)).add(plane.yDirection.multiply(v * scale)),
  );
  const edges = points.map((p, i) => EdgeOps.makeLineEdge(p, points[(i + 1) % points.length]));
  const profile = WireOps.makeWireFromEdges(edges);
  const face = FaceOps.makeFaceOnPlaneWrapped(profile, plane);
  const automatic = resolveSweepSpec(wire, [face]);
  const vertex = EdgeOps.getFirstVertexRaw(edge.getShape());
  const axial = resolveSweepSpec(wire, [face], {
    transport: { kind: "binormal", axis: frame.mainDirection },
    placement: { kind: "atVertex", vertex },
  });
  return {
    geometry, plane, points, profile, wire, automatic, axial,
    dispose() {
      vertex.delete();
      for (const shape of [face, profile, ...edges, wire, edge]) shape.dispose();
    },
  };
}

export type OrientationFixture = ReturnType<typeof orientationFixture>;

/** Independent analytic screw motion of an authored point, including its offset. */
export function screwPoint(fixture: OrientationFixture, point: Point, fraction: number): Point {
  const { frame, winding, parameterEnd, zStart, zEnd } = fixture.geometry;
  return Matrix4.fromRotationAroundAxis(frame.origin, frame.mainDirection, winding * parameterEnd * fraction)
    .transformPoint(point).add(frame.mainDirection.multiply((zEnd - zStart) * fraction));
}

function vertices(shape: TopoDS_Shape): Point[] {
  return Explorer.findShapes(shape, Explorer.getOcShapeType("vertex")).map(raw => {
    const vertex = getOC().TopoDS.Vertex(raw);
    try {
      return EdgeOps.getVertexPointRaw(vertex);
    } finally {
      vertex.delete();
      raw.delete();
    }
  });
}

/** Sample every quarter turn or more often. Never build on the simulated builder. */
export function sectionMetrics(fixture: OrientationFixture, spec: ResolvedSweepSpec) {
  const placement = spec.placement;
  return PipeRun.withBuilder(spec.spine.wire, {
    wire: fixture.profile.getShape(),
    placed: placement.kind !== "legacyAutomatic",
    withCorrection: placement.kind === "legacyAutomatic" && placement.withCorrection,
    location: placement.kind === "atVertex" ? placement.vertex : undefined,
    atStart: placement.kind === "atStart",
    transform: placement.kind === "atStart" ? placement.transform : undefined,
  }, spec.transport, pipe => {
    const count = Math.max(5, Math.ceil(fixture.geometry.turns * 4) + 1);
    const sections = new (getOC().TopTools_ListOfShape)();
    try {
      pipe.Simulate(count, sections);
      const frames: Point[][] = [];
      while (sections.Size()) {
        const section = sections.First();
        frames.push(vertices(section));
        sections.RemoveFirst();
        section.delete();
      }
      // Some parameter ranges append the endpoint twice after rounding the
      // last step. Only discard it if the returned geometry proves duplication.
      if (frames.length === count + 1) {
        const last = frames.at(-1)!;
        const previous = frames.at(-2)!;
        if (last.length === previous.length && last.every((p, i) => p.distanceTo(previous[i]) < 1e-7)) {
          frames.pop();
        }
      }
      if (frames.length !== count || frames.some(frame => frame.length !== 4)) {
        throw new Error(`Section sampling returned ${frames.length}/${count} sections; vertex counts: ${frames.map(f => f.length).join(",")}.`);
      }
      // Match the initial order to the input, never use the simulated first
      // section as the oracle: that would hide an unwanted initial correction.
      const input = frames[0].map(point => fixture.points.reduce((best, p) =>
        p.distanceTo(point) < best.distanceTo(point) ? p : best,
      ));
      if (new Set(input).size !== 4) throw new Error("Section vertex correspondence is ambiguous.");
      let maxVertexError = 0;
      let maxRollDegrees = 0;
      let previousRoll = 0;
      const initialDirection = input[0].vectorTo(input[1]).normalize();
      frames.forEach((frame, i) => {
        const f = i / (frames.length - 1);
        const angle = fixture.geometry.winding * fixture.geometry.parameterEnd * f;
        const inverseRotation = Matrix4.fromRotationAroundAxis(
          Point.origin(), fixture.geometry.frame.mainDirection, -angle,
        );
        const direction = inverseRotation.transformDirection(frame[0].vectorTo(frame[1])).normalize();
        let roll = Math.atan2(
          fixture.plane.normal.dot(initialDirection.cross(direction)), initialDirection.dot(direction),
        ) * 180 / Math.PI;
        while (roll - previousRoll > 180) roll -= 360;
        while (roll - previousRoll < -180) roll += 360;
        previousRoll = roll;
        maxRollDegrees = Math.max(maxRollDegrees, Math.abs(roll));
        frame.forEach((point, j) => {
          maxVertexError = Math.max(maxVertexError, point.distanceTo(screwPoint(fixture, input[j], f)));
        });
      });
      return { maxVertexError, maxRollDegrees };
    } finally {
      sections.delete();
    }
  }, spec.tolerances, spec.helixGeometry);
}

/** Distance to a shell (a solid would return zero for points in its interior). */
export function boundaryError(fixture: OrientationFixture, solid: TopoDS_Shape, transform?: Matrix4): number {
  const oc = getOC();
  const shells = Explorer.findShapes(solid, oc.TopAbs_ShapeEnum.TopAbs_SHELL);
  if (shells.length !== 1) throw new Error("Expected one cutter shell.");
  const shell = shells[0];
  let maxError = 0;
  try {
    // Vertices AND interior points of each profile edge. The latter test the
    // fitted lateral surfaces, not just OCCT's separately fitted edge curves.
    const profileSamples = fixture.points.flatMap((p, i) => [
      p, p.add(p.vectorTo(fixture.points[(i + 1) % 4]).multiply(0.37)),
    ]);
    for (const fraction of [0.07, 0.23, 0.47, 0.71, 0.93]) {
      for (const sample of profileSamples) {
        const expected = screwPoint(fixture, sample, fraction);
        const point = transform ? transform.transformPoint(expected) : expected;
        const pnt = new oc.gp_Pnt(point.x, point.y, point.z);
        const maker = new oc.BRepBuilderAPI_MakeVertex(pnt);
        const vertex = maker.Vertex();
        const progress = new oc.Message_ProgressRange();
        const distance = new oc.BRepExtrema_DistShapeShape(
          vertex, shell, oc.Extrema_ExtFlag.Extrema_ExtFlag_MIN,
          oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad, progress,
        );
        try {
          if (!distance.IsDone()) throw new Error("Boundary distance evaluation failed.");
          maxError = Math.max(maxError, distance.Value());
        } finally {
          distance.delete(); progress.delete(); vertex.delete(); maker.delete(); pnt.delete();
        }
      }
    }
    return maxError;
  } finally {
    shell.delete();
  }
}

/**
 * Independent removed volume for the R25/height120 fixture at the given pitch. Integrate
 * the screw-map Jacobian over the part of the trapezoid inside the cylinder.
 * The 10 mm end overshoots cover every section's axial tilt; turns do not
 * overlap. Simpson quadrature uses no OCCT geometry or measured cut volumes.
 */
export function analyticRemovedVolume(intervals = 20000, pitch = 28): number {
  const radius = 25 - 1e-6;
  const lead = pitch / (2 * Math.PI);
  const a = radius / Math.hypot(radius, lead);
  const b = lead / Math.hypot(radius, lead);
  const low = radius - 25;
  const step = (1 - low) / intervals;
  const integrand = (v: number) => {
    const halfWidth = 2.5 - (v + 4) * Math.tan(Math.PI / 12);
    const clippedWidth = Math.sqrt(Math.max(0, 25 ** 2 - (radius - v) ** 2)) / b;
    return 2 * Math.min(halfWidth, clippedWidth) * (a * (radius - v) + b * lead);
  };
  let sum = integrand(low) + integrand(1);
  for (let i = 1; i < intervals; i++) sum += (i % 2 ? 4 : 2) * integrand(low + step * i);
  return sum * step / 3 * 120 / lead;
}
