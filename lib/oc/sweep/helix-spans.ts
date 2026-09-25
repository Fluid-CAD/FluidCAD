import type { TopoDS_Edge, TopoDS_Wire } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { WireOps } from "../wire-ops.js";

/**
 * Bound each cylindrical helical face to one revolution. OCCT can return a
 * valid but unchanged cut when a single fitted face winds repeatedly through
 * a cylinder (R25, pitch14, ten turns). Trimming the SAME spine curve before
 * sweeping fixes that intersection failure without changing transport/fuzz.
 * Called only for a resolved cylindrical helix plus optional tangent lines.
 * The caller owns the returned wire when it differs from the input.
 */
export function boundedHelixSpine(spine: TopoDS_Wire): TopoDS_Wire {
  const oc = getOC();
  const explorer = new oc.BRepTools_WireExplorer(spine);
  const edges: TopoDS_Edge[] = [];
  let changed = false;
  try {
    while (explorer.More()) {
      const edge = explorer.Current();
      const adaptor = new oc.BRepAdaptor_Curve(edge);
      try {
        if (adaptor.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line) {
          const oriented = edge.Oriented(edge.Orientation());
          try { edges.push(oc.TopoDS.Edge(oriented)); }
          finally { oriented.delete(); }
        } else {
          const curve = oc.BRep_Tool.Curve(edge);
          try {
            // Authored helix curve parameter is angle in radians. The tiny
            // relative allowance avoids a sliver at an exact whole turn.
            const spans = Math.max(1, Math.ceil((curve.Last - curve.First) / (2 * Math.PI) - 1e-12));
            changed ||= spans > 1;
            const reversed = edge.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
            for (let i = 0; i < spans; i++) {
              const j = reversed ? spans - i - 1 : i;
              const first = curve.First + (curve.Last - curve.First) * j / spans;
              const last = curve.First + (curve.Last - curve.First) * (j + 1) / spans;
              const maker = new oc.BRepBuilderAPI_MakeEdge(curve.returnValue, first, last);
              try {
                if (!maker.IsDone()) throw new Error("Sweep failed to bound a helical spine span.");
                const piece = maker.Edge();
                if (reversed) piece.Reverse();
                edges.push(piece);
              } finally { maker.delete(); }
            }
          } finally { curve[Symbol.dispose](); }
        }
      } finally { adaptor.delete(); edge.delete(); }
      explorer.Next();
    }
    return changed ? WireOps.makeWireFromEdgesRaw(edges) : spine;
  } finally {
    explorer.delete();
    edges.forEach(edge => edge.delete());
  }
}
