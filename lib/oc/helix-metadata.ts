import type { Geom_Curve, TopoDS_Shape } from "ocjs-fluidcad";
import type { Shape } from "../common/shape.js";
import { getOC } from "./init.js";

/**
 * Exact native curve identity, not geometric recognition. MakeWire may copy
 * an edge to share junction vertices while retaining the same curve handle.
 * Embind exposes isAliasOf on handles although the generated OCCT declarations
 * omit that runtime method. Without it, fail closed and retain only IsSame.
 */
function sharesCurve(a: TopoDS_Shape, b: TopoDS_Shape): boolean {
  if (a.IsSame(b)) return true;
  const oc = getOC();
  const ea = oc.TopoDS.Edge(a), eb = oc.TopoDS.Edge(b);
  const ca = oc.BRep_Tool.Curve(ea), cb = oc.BRep_Tool.Curve(eb);
  try {
    const curve = ca.returnValue as Geom_Curve & { isAliasOf?: (other: Geom_Curve) => boolean };
    return curve.isAliasOf?.(cb.returnValue) === true;
  } finally {
    ca[Symbol.dispose](); cb[Symbol.dispose](); ea.delete(); eb.delete();
  }
}

/** Carry descriptors only onto edges sharing the source's actual native curve. */
export function inheritHelixGeometry<T extends Shape>(target: T, sources: readonly Shape[]): T {
  const entries = sources.flatMap(source => [...source.getHelixEdges()]);
  if (entries.length === 0) return target;
  const oc = getOC();
  const explorer = new oc.TopExp_Explorer(target.getShape(), oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  try {
    while (explorer.More()) {
      const edge = explorer.Current();
      try {
        const match = entries.find(entry => sharesCurve(edge, entry.edge));
        if (match) target.recordHelixGeometry(edge, match.geometry);
      } finally {
        edge.delete();
      }
      explorer.Next();
    }
  } finally {
    explorer.delete();
  }
  return target;
}
