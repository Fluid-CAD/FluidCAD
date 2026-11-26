import type { TopoDS_Shape, TopoDS_Shell, TopoDS_Solid } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { ShapeOps } from "./shape-ops.js";
import { TopologyIndex } from "./topology-index.js";
import { WireOps } from "./wire-ops.js";
import { requireValidSolid } from "./solid-validation.js";
import { BuildError } from "../common/build-error.js";
import { ShapeFactory } from "../common/shape-factory.js";
import { Sheet } from "../common/sheet.js";
import { Solid } from "../common/solid.js";
import type { Shape } from "../common/shape.js";
import type { Face } from "../common/face.js";
import type { Edge } from "../common/edge.js";
import type { Wire } from "../common/wire.js";
import { mmTol } from "../units/tolerance.js";

/**
 * The one home for assembling and inspecting shells: surfaces made from
 * faces, sewn from pieces, closed into solids, and their rims read back.
 * Every sheet returned belongs to the caller.
 */
export class SheetOps {
  /**
   * The default gap sewing closes: the kernel's confusion distance, in mm.
   * Faces built from shared curves meet exactly; a caller sewing faces that
   * were approximated or imported passes the tolerance their source carries.
   */
  static get SEWING_TOLERANCE(): number {
    return mmTol(1e-6);
  }

  /** One face as a one-face sheet. The sheet shares the face's geometry (its face `IsSame` the input). */
  static fromFace(face: Face): Sheet {
    return SheetOps.fromRawFace(face.getShape());
  }

  /** {@link fromFace} for a raw face handle, which stays the caller's. */
  static fromRawFace(face: TopoDS_Shape): Sheet {
    return Sheet.fromTopoDSShell(SheetOps.makeShellRaw([face]));
  }

  /**
   * One sheet per group of faces that share an edge (the same edge, not two
   * edges that happen to coincide): faces lifted out of one body keep the
   * connections they had there, and nothing is sewn. Faces that only touch
   * geometrically stay apart. Groups come in the order of their first face.
   */
  static fromFaces(faces: Face[]): Sheet[] {
    const oc = getOC();
    const distinct: Face[] = [];
    const seen = new oc.TopTools_MapOfShape();
    try {
      for (const face of faces) {
        if (seen.Add(face.getShape())) {
          distinct.push(face);
        }
      }
    } finally {
      seen.delete();
    }
    if (distinct.length === 0) {
      return [];
    }

    const compound = ShapeOps.makeCompoundRaw(distinct.map(f => f.getShape()));
    const index = TopologyIndex.buildEdgeToFaces(compound);
    const parent = distinct.map((_, i) => i);
    const root = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    try {
      const position = new Map(distinct.map((face, i) => [face, i]));
      for (const sharing of TopologyIndex.groupFacesByEdgeSlot(index, distinct).values()) {
        for (let k = 1; k < sharing.length; k++) {
          const a = root(position.get(sharing[0])!);
          const b = root(position.get(sharing[k])!);
          if (a !== b) {
            parent[Math.max(a, b)] = Math.min(a, b);
          }
        }
      }
    } finally {
      index.delete();
      compound.delete();
    }

    const groups = new Map<number, TopoDS_Shape[]>();
    distinct.forEach((face, i) => {
      const group = root(i);
      if (!groups.has(group)) {
        groups.set(group, []);
      }
      groups.get(group)!.push(face.getShape());
    });
    return [...groups.values()].map(group => Sheet.fromTopoDSShell(SheetOps.makeShellRaw(group)));
  }

  /**
   * Faces and surfaces from different sources sewn into surfaces: edges
   * closer than `tolerance` become one, and every connected result is one
   * sheet. A sewn result that closes stays a sheet — making it a solid is
   * {@link solidFromClosed}'s decision, not sewing's.
   */
  static sew(shapes: Shape[], tolerance = SheetOps.SEWING_TOLERANCE): Sheet[] {
    const refused = shapes.find(shape => !shape.isFace() && !shape.isSheet());
    if (refused) {
      throw new BuildError(
        `Only faces and surfaces can be sewn into a surface; got a ${refused.getType()}.`,
        "Pass the faces to join, for example a body's faces(), rather than the body itself.",
      );
    }
    const { sewn } = SheetOps.sewRaw(shapes.map(s => s.getShape()), tolerance);
    const bodies = ShapeFactory.adoptAll(sewn);
    if (bodies.some(body => !body.isSheet())) {
      const kinds = bodies.map(body => body.getType()).join(", ");
      for (const body of bodies) body.dispose();
      throw new Error(`SheetOps.sew: sewing returned more than surfaces (${kinds}).`);
    }
    return bodies as Sheet[];
  }

  /**
   * The sewing every caller shares, so its options live in one place: sew
   * (option 1), analyse degenerated shapes (2), cut free edges at their
   * intersections (3), manifold output only (4 off). Hands back the sewn
   * shape, which the caller owns, and how many free edges remain — a closed
   * result has none.
   */
  static sewRaw(shapes: TopoDS_Shape[], tolerance: number): { sewn: TopoDS_Shape; freeEdges: number } {
    const oc = getOC();
    const sewing = new oc.BRepBuilderAPI_Sewing(tolerance, true, true, true, false);
    const progress = new oc.Message_ProgressRange();
    try {
      for (const shape of shapes) {
        sewing.Add(shape);
      }
      sewing.Perform(progress);
      return { sewn: sewing.SewedShape(), freeEdges: sewing.NbFreeEdges() };
    } finally {
      progress.delete();
      sewing.delete();
    }
  }

  /**
   * The sheet with its faces turned to agree with their neighbours across
   * every shared edge, so its normals run to one side throughout. Sewing
   * joins faces whatever their orientation; this is the pass after it.
   * The input sheet is left as it was.
   */
  static orient(sheet: Sheet): Sheet {
    const oc = getOC();
    const fixer = new oc.ShapeFix_Shell();
    try {
      // One shell out, as one went in: the sheet is already one connected surface.
      fixer.FixFaceOrientation(sheet.getShape(), false, false);
      return Sheet.fromTopoDSShell(fixer.Shell());
    } finally {
      fixer.delete();
    }
  }

  /** The sheet's rim chained into wires — closed loops, or open chains where a seam interrupts it. The caller owns them. */
  static boundaryWires(sheet: Sheet): Wire[] {
    const rim = sheet.getBoundaryEdges();
    return rim.length === 0 ? [] : WireOps.connectEdgesToWires(rim);
  }

  /**
   * A closed sheet as a solid, oriented outward and validated. A sheet with
   * a rim does not bound a volume, and is refused with the size of its gap.
   */
  static solidFromClosed(sheet: Sheet): Solid {
    const oc = getOC();
    if (!sheet.isClosed()) {
      const rim = sheet.getBoundaryEdges().length;
      throw new BuildError(
        `The surface is open along ${rim} edge${rim === 1 ? "" : "s"}, so it does not enclose a volume.`,
        "Close the opening, by adding the missing faces or filling the open rim, before making the surface a solid.",
      );
    }

    const maker = new oc.BRepBuilderAPI_MakeSolid(sheet.getShape());
    let solid: TopoDS_Solid;
    try {
      if (!maker.IsDone()) {
        throw new BuildError(
          "The kernel could not make a solid from the closed surface.",
          "Check the surface for faces that overlap or cross each other.",
        );
      }
      solid = maker.Solid();
    } finally {
      maker.delete();
    }

    try {
      // The faces carry whatever orientation the sheet gave them; the solid
      // must face outward or its volume comes out negative.
      if (!oc.BRepLib.OrientClosedSolid(solid)) {
        throw new BuildError(
          "The closed surface could not be oriented as a solid.",
          "Check the surface for faces that overlap or cross each other.",
        );
      }
      requireValidSolid(solid, "Solid from closed surface", 1);
      return Solid.fromTopoDSSolid(solid);
    } catch (error) {
      solid.delete();
      throw error;
    }
  }

  /** The one or two faces of the sheet that `edge` bounds, as the sheet's own face wrappers. */
  static facesConnectedAt(sheet: Sheet, edge: Edge): Face[] {
    return sheet.getFacesOfEdge(edge);
  }

  /**
   * A new shell holding `faces` as they are (same faces, same orientation),
   * flagged closed when no edge is left free, as the kernel's own shell
   * makers flag theirs. The caller owns the shell.
   */
  private static makeShellRaw(faces: TopoDS_Shape[]): TopoDS_Shell {
    const oc = getOC();
    const builder = new oc.BRep_Builder();
    const shell = new oc.TopoDS_Shell();
    try {
      builder.MakeShell(shell);
      for (const face of faces) {
        builder.Add(shell, face);
      }
      shell.Closed(oc.BRep_Tool.IsClosed(shell));
      return shell;
    } catch (error) {
      shell.delete();
      throw error;
    } finally {
      builder.delete();
    }
  }
}
