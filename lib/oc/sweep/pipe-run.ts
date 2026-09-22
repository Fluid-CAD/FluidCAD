import type { TopoDS_Shape, TopoDS_Wire } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { Convert } from "../convert.js";
import type { SpineTrihedron } from "./spine-analysis.js";

/** One MakePipeShell result: the pipe and the section faces at its two ends. */
export interface PipeRunResult {
  solid: TopoDS_Shape;
  firstFace: TopoDS_Shape;
  lastFace: TopoDS_Shape;
}

/**
 * The section to carry along a run. A `placed` section already sits on the
 * spine start, square to it, and is used as-is; an unplaced one is the
 * user's profile, which OCC may rotate square to the spine (`withCorrection`).
 */
export interface PipeSection {
  wire: TopoDS_Wire;
  placed: boolean;
  withCorrection: boolean;
}

/** Sweeps one section along one G1 spine with `BRepOffsetAPI_MakePipeShell`. */
export class PipeRun {
  // Ceiling for MakePipeShell's swept-surface approximation. OCCT's default
  // (~30) is too small for tapered or tightly-coiled helical spines, whose
  // swept surfaces need many spans to fit within tolerance — at the default the
  // build silently fails (BRepBuilderAPI_PipeNotDone). This only caps the
  // adaptive fit; simple spines converge far below it at no extra cost.
  private static readonly MAX_PIPE_SEGMENTS = 1000;

  static sweep(spine: TopoDS_Wire, section: PipeSection, trihedron: SpineTrihedron): PipeRunResult {
    const oc = getOC();
    const pipe = new oc.BRepOffsetAPI_MakePipeShell(spine);
    const disposers: (() => void)[] = [];
    try {
      if (trihedron.kind === "binormal") {
        // Fixed binormal (the spine's tangent-rotation axis; see
        // SpineAnalysis.trihedron): keeps the swept section from twisting —
        // a clean coil rather than a wobbling ribbon — and is well-defined on
        // straight spines, where Frenet is not (zero curvature ⇒ undefined
        // normal). A twisted spine gets OCCT's corrected Frenet default.
        const [binormalDir, dispose] = Convert.toGpDir(trihedron.axis);
        disposers.push(dispose);
        pipe.SetMode(binormalDir);
      }
      // Give the swept-surface approximation enough spans for tapered/tight
      // helical spines (see MAX_PIPE_SEGMENTS) — at OCCT's default budget the
      // build fails on, e.g., a conical helix or a many-turn helix on a cone face.
      pipe.SetMaxSegments(PipeRun.MAX_PIPE_SEGMENTS);
      // The spine handed in is G1 by construction (SpineAnalysis splits it at
      // corners), so OCCT's default transition — which would carry the frame
      // across a corner unturned and flatten the section — never triggers.
      pipe.Add(section.wire, false, section.placed ? false : section.withCorrection);

      const progress = new oc.Message_ProgressRange();
      pipe.Build(progress);
      progress.delete();

      if (!pipe.IsDone()) {
        throw new Error("Sweep operation failed.");
      }
      if (!pipe.MakeSolid()) {
        throw new Error("Sweep failed to produce a solid.");
      }
      return { solid: pipe.Shape(), firstFace: pipe.FirstShape(), lastFace: pipe.LastShape() };
    } finally {
      pipe.delete();
      disposers.forEach(dispose => dispose());
    }
  }
}
