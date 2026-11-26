import type { TopoDS_Shape } from "ocjs-fluidcad";
import { ShapeValidator, type ShapeValidation } from "./shape-validator.js";

export class SheetValidationError extends Error {
  constructor(
    readonly stage: string,
    reason: string,
    readonly validation?: ShapeValidation,
  ) {
    super(`${stage} validation failed: ${reason}`);
    this.name = "SheetValidationError";
  }
}

/**
 * Validate a surface before adoption: its faces must be sound, but an open
 * rim and the absence of a solid are what a surface is, not faults.
 * Does not repair or mutate the input.
 */
export function requireValidSheet(
  shape: TopoDS_Shape, stage: string, expectedSheets?: number,
): ShapeValidation {
  try {
    if (shape.IsNull()) throw new SheetValidationError(stage, "kernel returned a null shape");
    const validation = ShapeValidator.validate(shape, 'sheet');
    if (validation.findings.length) {
      throw new SheetValidationError(stage, validation.findings.map(f => `${f.kind}: ${f.message}`).join("; "), validation);
    }
    if (expectedSheets !== undefined && validation.sheets !== expectedSheets) {
      throw new SheetValidationError(stage, `expected ${expectedSheets} surface(s), received ${validation.sheets}`, validation);
    }
    return validation;
  } catch (error) {
    if (error instanceof SheetValidationError) throw error;
    throw new SheetValidationError(stage, error instanceof Error ? error.message : String(error));
  }
}
