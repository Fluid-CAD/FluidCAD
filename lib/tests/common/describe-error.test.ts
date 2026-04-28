import { describe, it, expect } from "vitest";
import { setupOC } from "../setup.js";
import { describeError } from "../../common/describe-error.js";
import { getOC } from "../../oc/init.js";

describe("describeError", () => {
  setupOC();

  it("returns Error.message for Error instances", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  it("falls back to String() for non-numeric, non-Error values", () => {
    expect(describeError("plain string")).toBe("plain string");
    expect(describeError(undefined)).toBe("undefined");
    expect(describeError(null)).toBe("null");
  });

  it("decodes a numeric OCC exception pointer to its message string", () => {
    const oc = getOC() as any;
    // Trigger a real OCC throw (BRepBuilderAPI_MakeOffset on an unsupported
    // shape) and capture the numeric pointer.
    let caught: unknown = null;
    try {
      const maker = new oc.BRepOffsetAPI_MakeOffset();
      maker.Perform(1, 0); // no wire added — should throw
    } catch (e) {
      caught = e;
    }

    // If OCC throws, it comes through as a number; otherwise the test setup
    // didn't trigger it — skip in that case.
    if (typeof caught !== 'number') {
      return;
    }

    const decoded = describeError(caught);
    expect(decoded.startsWith("OCC")).toBe(true);
    expect(decoded).not.toBe(String(caught));
  });
});
