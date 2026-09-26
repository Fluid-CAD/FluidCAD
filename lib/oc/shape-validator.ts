import type { TopAbs_ShapeEnum, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";

/**
 * The closed vocabulary of what a shape check can find. Every kind maps to
 * one kernel question, so a report reads as evidence rather than opinion:
 *
 * - `invalidTopology`: `BRepCheck_Analyzer` (geometric controls on) found a
 *   defect — a wire that does not close, a face whose pcurves drift off the
 *   surface, an edge without the faces it needs.
 * - `openShell`: a shell that `BRep_Tool::IsClosed` says has a free edge — a
 *   five-face box "renders fine" and is this.
 * - `nonPositiveVolume`: a solid whose signed volume is <= 0. The analyzer
 *   accepts a reversed solid as valid, so the volume sign is the only check
 *   that catches inversion. Measured per solid, never summed across a
 *   compound: +1000 and -1000 must not cancel.
 * - `noSolid`: the shape contains no solid at all (a face, a wire, a shell
 *   left un-solidified).
 * - `nonFiniteGeometry`: geometry bounds are void/unbounded/non-finite, or
 *   signed-volume integration returned a non-finite value.
 *
 * `selfIntersecting` is NOT in this vocabulary: the basic validator
 * does not request native self-interference analysis. That expensive check
 * is available only through explicit diagnostics. A check that is not run is not reported.
 */
export type ShapeFindingKind = 'invalidTopology' | 'openShell' | 'nonPositiveVolume' | 'noSolid' | 'nonFiniteGeometry';

export type ShapeFinding = { kind: ShapeFindingKind; message: string };

export type ShapeValidation = {
  faces: number;
  edges: number;
  shells: number;
  solids: number;
  /** `BRepCheck_Analyzer` verdict. True for a reversed solid — see `solidVolumes`. */
  validTopology: boolean;
  /** Every shell is closed. Vacuously true for a shape without shells. */
  closed: boolean;
  /** Signed volume per solid, in the document unit cubed. Never aggregated. */
  solidVolumes: number[];
  findings: ShapeFinding[];
};

/**
 * Kernel-level soundness checks for one shape. Stateless: every OCCT handle
 * it creates is deleted before it returns, and it never mutates or repairs
 * the input (repairs belong to {@link ShapeOps.cleanShapeRaw}).
 */
export class ShapeValidator {

  /** The checks this basic validator runs. */
  static readonly CHECKS: readonly ShapeFindingKind[] = ['invalidTopology', 'openShell', 'nonPositiveVolume', 'noSolid', 'nonFiniteGeometry'];

  /** Checks a caller might expect that this validator does not run, with the reason. */
  static readonly UNAVAILABLE: Readonly<Record<string, string>> = {
    selfIntersecting: 'not checked: BRepAlgoAPI_Check self-interference analysis is an explicit diagnostic, not an automatic build or inspection check',
  };

  /**
   * The eps-driven volume integration `ShapeProps` uses — the fixed-order
   * quadrature under-integrates faces trimmed by fitted pcurves.
   */
  private static readonly VOLUME_EPS = 1e-6;

  static validate(shape: TopoDS_Shape): ShapeValidation {
    const oc = getOC();
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
    const SHELL = oc.TopAbs_ShapeEnum.TopAbs_SHELL as TopAbs_ShapeEnum;
    const SOLID = oc.TopAbs_ShapeEnum.TopAbs_SOLID as TopAbs_ShapeEnum;

    const owned: TopoDS_Shape[] = [];
    const own = (shapes: TopoDS_Shape[]) => { owned.push(...shapes); return shapes; };
    try {
      const faces = own(Explorer.findShapes(shape, FACE)).length;
      const edges = own(Explorer.findShapes(shape, EDGE)).length;
      const shells = own(Explorer.findShapes(shape, SHELL));
      const solids = own(ShapeValidator.solidsOf(shape, SOLID));

      const findings: ShapeFinding[] = [];

      // Finite bounds are a geometry check, independent of a positive volume.
      if (faces || edges) {
        const bounds = new oc.Bnd_Box();
        try {
          oc.BRepBndLib.AddOptimal(shape, bounds, false, false);
          const values = bounds.IsVoid() || bounds.IsOpen() ? null : [
            bounds.GetXMin(), bounds.GetXMax(), bounds.GetYMin(), bounds.GetYMax(), bounds.GetZMin(), bounds.GetZMax(),
          ];
          if (!values || !values.every(Number.isFinite)) {
            findings.push({ kind: 'nonFiniteGeometry', message: 'geometry has void, unbounded or non-finite bounds' });
          }
        } finally { bounds.delete(); }
      }

      const validTopology = ShapeValidator.isValidTopology(shape);
      if (!validTopology) {
        findings.push({ kind: 'invalidTopology', message: 'BRepCheck_Analyzer reports a topology or parametrization defect' });
      }

      const openShells = ShapeValidator.openShellIndexes(shells);
      for (const index of openShells) {
        findings.push({
          kind: 'openShell',
          message: shells.length === 1
            ? 'the shell is not closed (a free edge; the surface does not enclose a volume)'
            : `shell ${index + 1} of ${shells.length} is not closed (a free edge; the surface does not enclose a volume)`,
        });
      }

      const solidVolumes = solids.map(solid => ShapeValidator.signedVolume(solid));
      for (let i = 0; i < solidVolumes.length; i++) {
        const volume = solidVolumes[i];
        if (!Number.isFinite(volume)) {
          findings.push({ kind: 'nonFiniteGeometry', message: `solid ${i + 1} has non-finite signed volume ${volume}` });
        } else if (volume <= 0) {
          const which = solids.length === 1 ? 'the solid' : `solid ${i + 1} of ${solids.length}`;
          const why = volume < 0 ? 'reversed orientation (inside-out); BRepCheck_Analyzer does not catch this' : 'degenerate (zero volume)';
          findings.push({ kind: 'nonPositiveVolume', message: `${which} has volume ${volume}: ${why}` });
        }
      }

      if (solids.length === 0) {
        findings.push({ kind: 'noSolid', message: `the shape contains no solid (${ShapeValidator.describeContents(faces, edges, shells.length)})` });
      }

      return {
        faces,
        edges,
        shells: shells.length,
        solids: solids.length,
        validTopology,
        closed: openShells.length === 0,
        solidVolumes,
        findings,
      };
    } finally { owned.forEach(item => item.delete()); }
  }

  /**
   * Every solid occurrence, NOT deduplicated by `IsSame`: that identity
   * ignores orientation, so a compound holding a solid and its reverse
   * would collapse to one entry and the cancellation the per-solid rule
   * exists to expose would go unreported. A well-formed shape never shares
   * a solid between parents, so this equals `Explorer.findShapes` there.
   */
  private static solidsOf(shape: TopoDS_Shape, SOLID: TopAbs_ShapeEnum): TopoDS_Shape[] {
    const oc = getOC();
    const explorer = new oc.TopExp_Explorer(shape, SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE as TopAbs_ShapeEnum);
    const solids: TopoDS_Shape[] = [];
    try {
      while (explorer.More()) {
        solids.push(explorer.Current());
        explorer.Next();
      }
    } finally {
      explorer.delete();
    }
    return solids;
  }

  private static isValidTopology(shape: TopoDS_Shape): boolean {
    const oc = getOC();
    const analyzer = new oc.BRepCheck_Analyzer(shape, true, true);
    try {
      return analyzer.IsValid();
    } finally {
      analyzer.delete();
    }
  }

  /** Indexes (into `shells`) of the shells with a free edge. */
  private static openShellIndexes(shells: TopoDS_Shape[]): number[] {
    const oc = getOC();
    const open: number[] = [];
    for (let i = 0; i < shells.length; i++) {
      if (!oc.BRep_Tool.IsClosed(shells[i])) {
        open.push(i);
      }
    }
    return open;
  }

  /**
   * Signed volume of a solid (or the sum over a compound's solids) in the
   * document unit cubed. Shared with {@link ShapeInterference}, whose
   * common-volume verdict must integrate the way the validator's does.
   */
  static signedVolume(solid: TopoDS_Shape): number {
    const oc = getOC();
    const props = new oc.GProp_GProps();
    try {
      oc.BRepGProp.VolumeProperties(solid, props, ShapeValidator.VOLUME_EPS, false, false);
      return props.Mass();
    } finally {
      props.delete();
    }
  }

  private static describeContents(faces: number, edges: number, shells: number): string {
    const parts: string[] = [];
    if (shells > 0) {
      parts.push(`${shells} shell${shells === 1 ? '' : 's'}`);
    }
    if (faces > 0) {
      parts.push(`${faces} face${faces === 1 ? '' : 's'}`);
    }
    if (edges > 0) {
      parts.push(`${edges} edge${edges === 1 ? '' : 's'}`);
    }
    return parts.length > 0 ? parts.join(', ') : 'empty';
  }
}
