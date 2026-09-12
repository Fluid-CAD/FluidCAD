import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { sketch, line, arc, ellipse, extrude, sweep, loft, fillet, plane } from "../../core/index.js";
import { edge } from "../../filters/index.js";
import { Loft } from "../../features/loft.js";
import { Solid } from "../../common/solid.js";

/**
 * A strongly skewed loft that shares its base outline with a foot already
 * lofted onto the pad makes the kernel return an empty fuse result without
 * an error flag. The feature must refuse that result: it records an error and
 * the existing solid stays in the scene, instead of the scene silently
 * emptying (which made every later selection resolve to nothing).
 */
describe("fuse with an empty kernel result", () => {
  setupOC();

  const padL = 30, padW = 20, padT = 6, padCornerR = 5;
  const gripMajor = 14, gripMinor = 10, gripPeakZ = 50, gripEndR = 20;
  const footL = 22, footW = 16, footCornerR = 4, footH = 12;
  const padAX = 0, padBX = 100;
  const midX = (padAX + padBX) / 2;
  const z0 = padT + footH;

  function padOutline(cx: number) {
    return () => {
      const x0 = cx - padL / 2, x1 = cx + padL / 2;
      const y0 = -padW / 2, y1 = padW / 2;
      line([x0, y0], [x1, y0]);
      line([x1, y0], [x1, y1]);
      line([x1, y1], [x0, y1]);
      line([x0, y1], [x0, y0]);
    };
  }

  function footBase(cx: number) {
    return sketch(plane("xy", padT), () => {
      const x0 = cx - footL / 2, x1 = cx + footL / 2;
      const y0 = -footW / 2, y1 = footW / 2;
      const b = line([x0, y0], [x1, y0]);
      const r = line([x1, y0], [x1, y1]);
      const t = line([x1, y1], [x0, y1]);
      const l = line([x0, y1], [x0, y0]);
      fillet(footCornerR, b, r, t, l);
    });
  }

  function castHandleBody() {
    sketch("xy", padOutline(padAX));
    const padA = extrude(padT);
    sketch("xy", padOutline(padBX));
    const padB = extrude(padT);
    fillet(padCornerR, padA.sideEdges(edge().verticalTo("xy")));
    fillet(padCornerR, padB.sideEdges(edge().verticalTo("xy")));

    const u = midX - gripEndR;
    const c = ((gripPeakZ - gripEndR) ** 2 - u * u - z0 * z0) / (2 * (gripPeakZ - gripEndR - z0));
    const k = (gripPeakZ - c) / Math.hypot(u, z0 - c);
    const tX = midX - u * k;
    const tZ = c + (z0 - c) * k;
    const gripPath = sketch("xz", () => {
      line([padAX, padT], [padAX, z0]);
      arc([padAX, z0], [tX, tZ], [padAX + gripEndR, z0]).cw();
      arc([tX, tZ], [2 * midX - tX, tZ], [midX, c]).cw();
      arc([2 * midX - tX, tZ], [padBX, z0], [padBX - gripEndR, z0]).cw();
      line([padBX, z0], [padBX, padT]);
    }).reusable();
    sketch(plane("xy", padT), () => ellipse([padAX, 0], gripMinor / 2, gripMajor / 2));
    sweep(gripPath);

    let foot: Loft | undefined;
    for (const cx of [padAX, padBX]) {
      const footTop = sketch(plane("xy", z0), () => ellipse([cx, 0], gripMinor / 2, gripMajor / 2));
      foot = loft(footBase(cx), footTop).startCondition("normal") as Loft;
    }
    return foot!;
  }

  it("records an error on the feature and keeps the existing solid", () => {
    const footB = castHandleBody();
    const skewedTop = sketch(plane("xy", z0), () => ellipse([padBX + 200, 0], gripMinor / 2, gripMajor / 2));
    const skewed = loft(footBase(padBX), skewedTop) as Loft;

    render();

    expect(skewed.getError()).toMatch(/returned no solid/);
    expect(skewed.getShapes()).toHaveLength(0);
    // The body built so far is still in the scene, owned by the last feature that fused into it.
    const kept = footB.getShapes();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toBeInstanceOf(Solid);
  });
});
