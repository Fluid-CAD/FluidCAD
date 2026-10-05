import type { BOPAlgo_CheckStatus, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";

export interface NativeShapeCheck {
  valid: boolean;
  faultCount: number;
  /** Native execution failures are distinct from detected geometric faults. */
  errors: BOPAlgo_CheckStatus[];
  /** Bounded diagnostic sample; all faults still contribute to validity. */
  faults: { status: BOPAlgo_CheckStatus; subshapes: number }[];
}

/** OCCT's actual argument/self-interference check, with its native default tolerances. */
export function checkNativeShape(shape: TopoDS_Shape): NativeShapeCheck {
  const oc = getOC();
  if (typeof oc.BRepAlgoAPI_Check !== "function") {
    throw new Error("Missing WASM binding: BRepAlgoAPI_Check. Native self-interference validation cannot run with this ocjs-fluidcad build.");
  }
  const checker = new oc.BRepAlgoAPI_Check();
  const progress = new oc.Message_ProgressRange();
  try {
    // Small-edge rejection is a different check. SI is explicitly enabled.
    checker.SetData(shape, false, true);
    // The linked OCCT V8 WASM crashes inside threaded CheckerSI on the
    // ten-turn cone fixture. Keep the same native check in sequential mode.
    checker.SetRunParallel(false);
    checker.Perform(progress);
    if (checker.HasErrors()) throw new Error("BRepAlgoAPI_Check failed to complete native self-interference analysis.");
    const valid = checker.IsValid();
    const results = checker.Result();
    try {
      const faultCount = results.Size();
      const faults: NativeShapeCheck["faults"] = [];
      const errors = new Set<BOPAlgo_CheckStatus>();
      while (!results.IsEmpty()) {
        const result = results.First();
        try {
          const status = result.GetCheckStatus();
          // BRepAlgoAPI_Check does not copy its analyzer's error report.
          // That analyzer appends these result statuses for aborted/native
          // failures; checking HasErrors() alone would misclassify them.
          if (status === oc.BOPAlgo_CheckStatus.BOPAlgo_OperationAborted ||
            status === oc.BOPAlgo_CheckStatus.BOPAlgo_CheckUnknown) errors.add(status);
          if (faults.length < 16) {
            const shapes = result.GetFaultyShapes1();
            try { faults.push({ status, subshapes: shapes.Size() }); }
            finally { shapes.delete(); }
          }
        } finally { result.delete(); }
        results.RemoveFirst();
      }
      if (!valid && faultCount === 0) throw new Error("BRepAlgoAPI_Check rejected the shape without diagnostic results.");
      return { valid: valid && faultCount === 0, faultCount, faults, errors: [...errors] };
    } finally { results.delete(); }
  } finally { progress.delete(); checker.delete(); }
}
