import type { TopoDS_Shape } from "ocjs-fluidcad";
import { ShapeValidator, type ShapeValidation } from "./shape-validator.js";
import { checkNativeShape, type NativeShapeCheck } from "./native-shape-check.js";

export class SolidValidationError extends Error {
  constructor(
    readonly stage: string,
    reason: string,
    readonly validation?: ShapeValidation,
    readonly nativeCheck?: NativeShapeCheck,
  ) {
    super(`${stage} validation failed: ${reason}`);
    this.name = "SolidValidationError";
  }
}

/**
 * Validate a solid before adoption. Native self-interference analysis is an
 * explicit diagnostic option, never part of automatic builds or previews.
 * Does not repair or mutate the input.
 */
export function requireValidSolid(
  shape: TopoDS_Shape, stage: string, expectedSolids?: number,
  options: { selfInterference?: boolean } = {},
): ShapeValidation {
  try {
    if (shape.IsNull()) throw new SolidValidationError(stage, "kernel returned a null shape");
    const validation = ShapeValidator.validate(shape);
    if (validation.findings.length) {
      throw new SolidValidationError(stage, validation.findings.map(f => `${f.kind}: ${f.message}`).join("; "), validation);
    }
    if (expectedSolids !== undefined && validation.solids !== expectedSolids) {
      throw new SolidValidationError(stage, `expected ${expectedSolids} solid(s), received ${validation.solids}`, validation);
    }
    if (options.selfInterference) {
      const native = checkNativeShape(shape);
      if (native.errors.length) {
        throw new SolidValidationError(stage,
          `BRepAlgoAPI_Check analysis did not complete: ${native.errors.join(", ")}`, validation, native);
      }
      if (!native.valid) {
        throw new SolidValidationError(stage,
          `BRepAlgoAPI_Check rejected the shape (${native.faultCount} fault(s)): ` +
          native.faults.map(f => `${f.status}, ${f.subshapes} subshape(s)`).join("; "), validation, native);
      }
    }
    return validation;
  } catch (error) {
    if (error instanceof SolidValidationError) throw error;
    throw new SolidValidationError(stage, error instanceof Error ? error.message : String(error));
  }
}
