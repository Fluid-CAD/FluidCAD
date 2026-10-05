import { afterEach, describe, expect, it, vi } from "vitest";
import { getOC } from "../../oc/init.js";
import { SweepOps, type SweepResult } from "../../oc/sweep-ops.js";
import { SweepBuildError } from "../../oc/sweep/pipe-run.js";
import { ShapeValidator } from "../../oc/shape-validator.js";
import { withUnit } from "../../units/registry.js";
import { MM_PER_UNIT } from "../../units/units.js";
import { analyticRemovedVolume, boundaryError, orientationFixture } from "../helpers/sweep-orientation.js";

function dispose(result: SweepResult) {
  result.solids.forEach(solid => solid.dispose());
  result.firstShape.delete(); result.lastShape.delete();
}

afterEach(() => vi.restoreAllMocks());

describe("physical sweep fit budgets", () => {
  it.each(["mm", "in", "m"] as const)("builds the same five- and ten-turn grooves in %s", unit => withUnit(unit, () => {
    const oc = getOC();
    const scale = 1 / MM_PER_UNIT[unit];
    for (const turns of [5, 10]) {
      const pitch = 140 / turns;
      const fixture = orientationFixture(pitch * scale, turns, false, undefined, scale);
      let result: SweepResult | undefined;
      try {
        result = SweepOps.buildResolved(fixture.automatic);
        expect(result.solids).toHaveLength(1);
        expect(result.diagnostics).toHaveLength(1);
        const diagnostic = result.diagnostics[0];
        expect(diagnostic.tolerances.unit).toBe(unit);
        expect(diagnostic.tolerances.linear3d / scale).toBeCloseTo(1e-4, 12);
        expect(diagnostic.tolerances.boundary / scale).toBeCloseTo(1e-4, 12);
        expect(diagnostic.status).toBe(oc.BRepBuilderAPI_PipeError.BRepBuilderAPI_PipeDone);
        expect(diagnostic.surfaceError).toBeGreaterThanOrEqual(0);
        expect(diagnostic.surfaceError! / scale).toBeLessThanOrEqual(1e-4);
        expect(boundaryError(fixture, result.solids[0].getShape()) / scale).toBeLessThanOrEqual(1e-3);

        const cylinder = new oc.BRepPrimAPI_MakeCylinder(25 * scale, 120 * scale);
        const stock = cylinder.Shape();
        const cut = new oc.BRepAlgoAPI_Cut();
        const args = new oc.TopTools_ListOfShape();
        const tools = new oc.TopTools_ListOfShape();
        const progress = new oc.Message_ProgressRange();
        try {
          args.Append(stock); tools.Append(result.solids[0].getShape());
          cut.SetArguments(args); cut.SetTools(tools);
          cut.SetNonDestructive(true); cut.SetFuzzyValue(1e-4 * scale);
          cut.Build(progress);
          expect(cut.IsDone()).toBe(true);
          expect(cut.HasErrors()).toBe(false);
          const shape = cut.Shape();
          try {
            const validation = ShapeValidator.validate(shape);
            expect(validation.findings).toEqual([]);
            expect(validation.solids).toBe(1);
            const removed = Math.PI * 25 ** 2 * 120 - validation.solidVolumes[0] / scale ** 3;
            expect(Math.abs(removed - analyticRemovedVolume(20000, pitch))).toBeLessThan(0.05);
          } finally { shape.delete(); }
        } finally {
          progress.delete(); tools.delete(); args.delete(); cut.delete(); stock.delete(); cylinder.delete();
        }
      } finally {
        if (result) dispose(result);
        fixture.dispose();
      }
    }
  }));
});

describe("sweep fit failure diagnostics", () => {
  it.each([NaN, Infinity, -1, 0.01])("rejects reported surface error %s before solidification", error => {
    const oc = getOC();
    const fixture = orientationFixture(28, 1);
    const report = vi.spyOn(oc.BRepOffsetAPI_MakePipeShell.prototype, "ErrorOnSurface").mockReturnValue(error);
    const solidify = vi.spyOn(oc.BRepOffsetAPI_MakePipeShell.prototype, "MakeSolid");
    const release = vi.spyOn(oc.BRepOffsetAPI_MakePipeShell.prototype, "delete");
    try {
      let failure: unknown;
      try { SweepOps.buildResolved(fixture.automatic); } catch (cause) { failure = cause; }
      expect(failure).toBeInstanceOf(SweepBuildError);
      const failed = failure as SweepBuildError;
      expect(failed.stage).toBe("surfaceFit");
      expect(failed.diagnostics.surfaceError).toBe(error);
      expect(failed.diagnostics.transport).toBe("helix");
      expect(failed.message).toContain("maxSegments=1000");
      expect(failed.message).toContain("mm");
      expect(report).toHaveBeenCalledTimes(1); // No orientation or tolerance retries.
      expect(solidify).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
      // The failure must release its builder so a clean rebuild still works.
      dispose(SweepOps.buildResolved(fixture.automatic));
    } finally { fixture.dispose(); }
  });

  it("retains kernel status when a build reports failure", () => {
    const oc = getOC();
    const fixture = orientationFixture(28, 1);
    vi.spyOn(oc.BRepOffsetAPI_MakePipeShell.prototype, "IsDone").mockReturnValue(false);
    vi.spyOn(oc.BRepOffsetAPI_MakePipeShell.prototype, "GetStatus")
      .mockReturnValue(oc.BRepBuilderAPI_PipeError.BRepBuilderAPI_PipeNotDone);
    const report = vi.spyOn(oc.BRepOffsetAPI_MakePipeShell.prototype, "ErrorOnSurface");
    try {
      expect(() => SweepOps.buildResolved(fixture.automatic)).toThrow(/Sweep build failed.*BRepBuilderAPI_PipeNotDone/);
      expect(report).not.toHaveBeenCalled();
    } finally { fixture.dispose(); }
  });

  it.each(["Build", "MakeSolid"] as const)("labels native exceptions from %s and releases the builder", method => {
    const oc = getOC();
    const fixture = orientationFixture(28, 1);
    vi.spyOn(oc.BRepOffsetAPI_MakePipeShell.prototype, method).mockImplementation(() => {
      throw new Error("native failure");
    });
    const release = vi.spyOn(oc.BRepOffsetAPI_MakePipeShell.prototype, "delete");
    try {
      expect(() => SweepOps.buildResolved(fixture.automatic))
        .toThrow(new RegExp(`Sweep ${method === "Build" ? "build" : "solid"} failed: Error: native failure`));
      expect(release).toHaveBeenCalledTimes(1);
    } finally { fixture.dispose(); }
  });
});
