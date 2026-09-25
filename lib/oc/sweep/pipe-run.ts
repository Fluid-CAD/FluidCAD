import type { BRepOffsetAPI_MakePipeShell, TopoDS_Shape, TopoDS_Vertex, TopoDS_Wire } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { Convert } from "../convert.js";
import type { SpineTrihedron } from "./spine-analysis.js";
import { LEGACY_SWEEP_TOLERANCES, type SweepTolerancePolicy } from "./sweep-spec.js";

/** One MakePipeShell result: the pipe and the section faces at its two ends. */
export interface PipeRunResult {
  solid: TopoDS_Shape;
  firstFace: TopoDS_Shape;
  lastFace: TopoDS_Shape;
}

/**
 * The section to carry along a run. A `placed` section already sits on the
 * selected station and is used as-is; an unplaced one is the
 * user's profile, which OCC may rotate square to the spine (`withCorrection`).
 */
export interface PipeSection {
  wire: TopoDS_Wire;
  placed: boolean;
  withCorrection: boolean;
  /** Explicit station, independent of the profile's offset from the path. */
  location?: TopoDS_Vertex;
}

/** Sweeps one section along one G1 spine with `BRepOffsetAPI_MakePipeShell`. */
export class PipeRun {
  static sweep(
    spine: TopoDS_Wire,
    section: PipeSection,
    trihedron: SpineTrihedron,
    tolerances = LEGACY_SWEEP_TOLERANCES,
  ): PipeRunResult {
    return PipeRun.withBuilder(spine, section, trihedron, pipe => {
      const oc = getOC();
      const progress = new oc.Message_ProgressRange();
      try {
        pipe.Build(progress);
      } finally {
        progress.delete();
      }
      if (!pipe.IsDone()) {
        throw new Error("Sweep operation failed.");
      }
      if (!pipe.MakeSolid()) {
        throw new Error("Sweep failed to produce a solid.");
      }
      return { solid: pipe.Shape(), firstFace: pipe.FirstShape(), lastFace: pipe.LastShape() };
    }, tolerances);
  }

  /**
   * One configuration for production building and diagnostic section sampling.
   * The callback borrows the builder; it is always deleted before returning.
   * Use separate calls for Simulate and Build: the installed kernel fails when
   * both run on the same builder (see the subtractive sweep research plan).
   */
  static withBuilder<T>(
    spine: TopoDS_Wire,
    section: PipeSection,
    trihedron: SpineTrihedron,
    run: (pipe: BRepOffsetAPI_MakePipeShell) => T,
    tolerances: SweepTolerancePolicy = LEGACY_SWEEP_TOLERANCES,
  ): T {
    const oc = getOC();
    const pipe = new oc.BRepOffsetAPI_MakePipeShell(spine);
    const disposers: (() => void)[] = [];
    try {
      if (trihedron.kind === "binormal") {
        const [binormalDir, dispose] = Convert.toGpDir(trihedron.axis);
        disposers.push(dispose);
        pipe.SetMode(binormalDir);
      } else {
        // Set every mode deliberately. OCCT's default is corrected Frenet;
        // true Frenet is an explicit comparator, not the general fallback.
        pipe.SetMode(trihedron.kind === "frenet");
      }
      // The audited OCCT sources default to 100 spans; some helical surfaces
      // need more. The ceiling limits the adaptive fit, not its accuracy.
      pipe.SetMaxSegments(tolerances.maxSegments);
      pipe.SetTolerance(tolerances.linear3d, tolerances.boundary, tolerances.angular);
      // The spine handed in is G1 by construction (SpineAnalysis splits it at
      // corners), so OCCT's default transition — which would carry the frame
      // across a corner unturned and flatten the section — never triggers.
      const correction = section.placed ? false : section.withCorrection;
      if (section.location) {
        pipe.Add(section.wire, section.location, false, correction);
      } else {
        pipe.Add(section.wire, false, correction);
      }
      return run(pipe);
    } finally {
      pipe.delete();
      disposers.forEach(dispose => dispose());
    }
  }
}
