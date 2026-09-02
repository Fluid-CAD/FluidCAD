import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { rad } from "../helpers/math-helpers.js";
import { Explorer } from "../oc/explorer.js";
import { getOC } from "../oc/init.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { mmTol } from "../units/tolerance.js";

/** The dialog values a ghost fillet/chamfer is built from, all resolved. */
export type FilletGhostOptions = {
  feature: 'fillet' | 'chamfer';
  /** Fillet radius, or the chamfer's first distance. */
  value: number;
  /** The chamfer's second value; null is the equal-distance overload. */
  distance2: number | null;
  /** The chamfer's second value is an angle in degrees, not a distance. */
  isAngle: boolean;
};

/**
 * Which way material moves where a band lands. A fillet on a convex edge
 * shaves material off; on a concave one it fills the corner in — the same
 * statement does both at once when the picks straddle a step.
 */
export type BandKind = 'add' | 'remove';

export type FilletGhostBands = {
  /** The surfaces the feature would create, one entry per generated face. */
  bands: { face: Face; kind: BandKind }[];
  /** Everything built on the way there; dispose it alongside the bands. */
  scratch: Shape[];
};

/**
 * Build the ghost bands for a fillet or chamfer: the surfaces the statement
 * would lay along the picked edges, and for each one whether it takes material
 * away or puts it back.
 *
 * Unlike the swept features, there is no standalone body to show — a fillet is
 * a modification of a solid that already exists, so the maker has to run on the
 * real target. What the ghost does NOT do is difference the two solids to
 * recover the chip of material that moves: that boolean is the whole cost of
 * the operation and it scales with the model's face count (measured: 46 ms on a
 * 6-face box, 222 ms at 42 faces, worse from there), which a per-keystroke
 * preview cannot afford. The maker already knows the answer — `Generated(edge)`
 * hands back exactly the faces it created — so the band is read straight out of
 * it for the price of the build alone.
 *
 * A refusal is silence, not an error: OCCT reports a radius too large for the
 * adjacent geometry as `IsDone() === false` with nothing generated, which is an
 * ordinary state to pass through while typing. Callers get no bands and show
 * no ghost.
 *
 * The caller owns disposal: every returned face and every `scratch` shape must
 * be `dispose()`d once meshed. None of it is reachable from scene state, so
 * `SceneDisposal` never collects it and leaks compound per keystroke.
 */
export function buildFilletGhostBands(
  target: Solid,
  edges: Edge[],
  options: FilletGhostOptions,
): FilletGhostBands {
  const bands: { face: Face; kind: BandKind }[] = [];
  const scratch: Shape[] = [];
  if (edges.length === 0 || !options.value) {
    return { bands, scratch };
  }

  const oc = getOC();
  const maker = options.feature === 'fillet'
    ? new oc.BRepFilletAPI_MakeFillet(target.getShape(), oc.ChFi3d_FilletShape.ChFi3d_Rational)
    : new oc.BRepFilletAPI_MakeChamfer(target.getShape());

  try {
    if (!addEdges(maker, target, edges, options, scratch)) {
      return { bands, scratch };
    }

    const progress = new oc.Message_ProgressRange();
    try {
      maker.Build(progress);
    } finally {
      progress.delete();
    }
    if (!maker.IsDone()) {
      return { bands, scratch };
    }

    for (const edge of edges) {
      for (const raw of ShapeOps.shapeListToArray(maker.Generated(edge.getShape()))) {
        if (!Explorer.isFace(raw)) {
          continue;
        }
        const face = Face.fromTopoDSFace(Explorer.toFace(raw));
        bands.push({ face, kind: bandKind(target, face) });
      }
    }
    return { bands, scratch };
  } catch (err) {
    // A throw strands everything built so far out of the caller's reach —
    // free it here so a failed ghost costs nothing.
    for (const band of bands) {
      band.face.dispose();
    }
    for (const shape of scratch) {
      shape.dispose();
    }
    throw err;
  } finally {
    maker.delete();
  }
}

/**
 * Feed the picked edges to the maker in the overload the dialog is showing.
 * The two-value chamfers measure their first distance from a reference face,
 * mirroring `Chamfer.build` (chamfer.ts:97) — an edge whose faces we can't
 * reach is a state to pass over in silence, so the whole ghost drops.
 */
function addEdges(
  maker: any,
  target: Solid,
  edges: Edge[],
  options: FilletGhostOptions,
  scratch: Shape[],
): boolean {
  const oc = getOC();
  if (options.feature === 'fillet') {
    for (const edge of edges) {
      maker.Add(options.value, oc.TopoDS.Edge(edge.getShape()));
    }
    return true;
  }
  if (!options.distance2) {
    for (const edge of edges) {
      maker.Add(options.value, oc.TopoDS.Edge(edge.getShape()));
    }
    return true;
  }

  // Every face of the target is wrapped to find each edge's reference face —
  // the caller frees them with the rest of the scratch.
  const faces = Explorer.findFacesWrapped(target);
  scratch.push(...faces);
  for (const edge of edges) {
    const reference = faces.find(f => f.hasEdge(edge.getShape()));
    if (!reference) {
      return false;
    }
    if (options.isAngle) {
      maker.AddDA(options.value, rad(options.distance2), oc.TopoDS.Edge(edge.getShape()),
        oc.TopoDS.Face(reference.getShape()));
    } else {
      maker.Add(options.value, options.distance2, oc.TopoDS.Edge(edge.getShape()),
        oc.TopoDS.Face(reference.getShape()));
    }
  }
  return true;
}

/**
 * Which way material moves under a band, decided by where the band sits
 * relative to the solid it modifies: a point on the new surface that falls
 * INSIDE the original was solid material a moment ago, so the feature is
 * removing it; one that falls outside is filling a concave corner in.
 *
 * The point is sampled on the surface itself (UV-bounds mid), not at the
 * face's centroid — the centroid of a curved patch is off the patch, and for a
 * fillet's quarter-cylinder it lands inside the material either way.
 */
function bandKind(target: Solid, face: Face): BandKind {
  const oc = getOC();
  const rawFace = oc.TopoDS.Face(face.getShape());
  const bounds = oc.BRepTools.UVBounds(rawFace);
  const surface = oc.BRep_Tool.Surface(rawFace);
  const props = new oc.GeomLProp_SLProps(
    surface,
    (bounds.UMin + bounds.UMax) / 2,
    (bounds.VMin + bounds.VMax) / 2,
    1,
    bandProbeTolerance(),
  );
  const classifier = new oc.BRepClass3d_SolidClassifier(target.getShape());
  try {
    const point = props.Value();
    classifier.Perform(point, bandProbeTolerance());
    return classifier.State() === oc.TopAbs_State.TopAbs_OUT ? 'add' : 'remove';
  } finally {
    classifier.delete();
    props.delete();
    surface.delete();
  }
}

/** Surface sampling and point classification both work well below feature size: 1e-7 mm. */
function bandProbeTolerance(): number {
  return mmTol(1e-7);
}
