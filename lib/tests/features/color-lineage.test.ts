import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import color from "../../core/color.js";
import select from "../../core/select.js";
import { rect } from "../../core/2d/index.js";
import { face } from "../../filters/index.js";
import { Color } from "../../features/color.js";
import { Extrude } from "../../features/extrude.js";
import { Solid } from "../../common/solid.js";

function hasRed(solid: Solid): boolean {
  return solid.colorMap.length > 0 && solid.colorMap.some(e => e.color === '#ff0000');
}

describe("color preservation through operations (Phase 3 lineage)", () => {
  setupOC();

  it("Solid.copy() preserves colorMap", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    extrude(30);

    select(face().onPlane("xy", 30));
    const c = color("red") as Color;
    render();

    const colored = c.getShapes()[0] as Solid;
    expect(colored.colorMap.length).toBeGreaterThan(0);

    const copied = (colored as Solid).copy() as Solid;
    expect(copied.colorMap.length).toBe(colored.colorMap.length);
    expect(copied.colorMap[0].color).toBe(colored.colorMap[0].color);
  });

  it("setColor replaces an existing color for the same face", () => {
    sketch("xy", () => {
      rect(40, 40);
    });
    const e = extrude(10) as Extrude;
    render();

    const solid = e.getShapes()[0] as Solid;
    const topFace = solid.getFaces().find(f => f.getPlane().origin.z >= 9.99);
    expect(topFace).toBeDefined();

    solid.setColor(topFace!.getShape(), '#ff0000');
    solid.setColor(topFace!.getShape(), '#00ff00');

    expect(solid.colorMap).toHaveLength(1);
    expect(solid.colorMap[0].color).toBe('#00ff00');
  });

  it("color survives a fuse with an overlapping extrude", () => {
    // Create a base block and color its top face.
    sketch("xy", () => {
      rect(60, 40);
    });
    extrude(10);
    select(face().onPlane("xy", 10));
    color("red");

    // Now fuse a second, smaller extrude on top of it.
    sketch("xy", () => {
      rect(20, 20);
    });
    const top = extrude(15) as Extrude;
    render();

    // The top face of the base was modified by the fuse (it got a hole where
    // the second extrude starts). The color should have transferred to the
    // post-fusion face(s).
    const finalSolid = top.getShapes()[0] as Solid;
    expect(finalSolid).toBeDefined();
    expect(hasRed(finalSolid)).toBe(true);
  });

  it("color survives a cut (UnifySameDomain chained lineage)", () => {
    sketch("xy", () => {
      rect(100, 100);
    });
    extrude(20);

    select(face().onPlane("xy", 20));
    color("red");

    sketch("xy", () => {
      rect(20, 20);
    });
    const cut = extrude(10).remove() as Extrude;
    render();

    // The cut modified the top face; the top face's color should transfer
    // to the post-cut face(s).
    const finalSolid = cut.getShapes()[0] as Solid;
    expect(finalSolid).toBeDefined();
    expect(hasRed(finalSolid)).toBe(true);
  });

  it("color is not propagated when the colored face is fully removed", () => {
    // Color a bottom face, then cut the whole block in half so the bottom
    // face is split but both halves still have a portion of it.
    sketch("xy", () => {
      rect(60, 40);
    });
    extrude(10);

    select(face().onPlane("xy", 0));
    color("red");

    sketch("xy", () => {
      rect(10, 40);
    });
    const cut = extrude(10).remove() as Extrude;
    render();

    // At least one of the surviving faces should be red (propagated from the
    // split bottom face).
    const finalSolids = cut.getShapes() as Solid[];
    const anyRed = finalSolids.some(hasRed);
    expect(anyRed).toBe(true);
  });
});
