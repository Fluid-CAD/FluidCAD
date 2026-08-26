import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import revolve from "../core/revolve.js";
import cut from "../core/cut.js";
import fillet from "../core/fillet.js";
import part from "../core/part.js";
import select from "../core/select.js";
import expose from "../core/expose.js";
import cylinder from "../core/cylinder.js";
import sphere from "../core/sphere.js";
import { circle } from "../core/2d/index.js";
import { testRect } from "./helpers/profiles.js";
import { face, edge } from "../filters/index.js";
import { Exposed, SerializedExposure } from "../features/exposed.js";
import { classifyContactShape } from "../oc/contact-classify.js";
import { findSolid } from "./selection/pick-helpers.js";
import { Explorer } from "../oc/explorer.js";
import { Scene } from "../rendering/scene.js";

const TWO_PI = Math.PI * 2;

/** Render the current scene and return the named exposure's serialized form. */
function renderExposure(name: string): { scene: Scene; data: SerializedExposure } {
  const scene = render();
  const exposures = scene.getAllSceneObjects().filter((o): o is Exposed => o instanceof Exposed);
  const match = exposures.find(e => e.exposeName === name);
  expect(match, `exposure "${name}" registered`).toBeDefined();
  return { scene, data: match!.serialize() };
}

function span(bounds: { uMin: number; uMax: number; vMin?: number; vMax?: number }): [number, number] {
  return [bounds.uMax - bounds.uMin, (bounds.vMax ?? 0) - (bounds.vMin ?? 0)];
}

describe("contact classification (exposure serialize)", () => {
  setupOC();

  it("classifies a box top face: plane, outward +Z, bbox bounds, no chain", () => {
    part("box", () => {
      sketch("xy", () => { testRect(40, 20); });
      extrude(10);
      expose("top", select(face().planar().onPlane("xy", 10)));
    });
    const { data } = renderExposure("top");

    expect(data.seed).not.toBeNull();
    const seed = data.seed!;
    expect(seed.form).toBe("plane");
    // Outward (material-out) normal of the top face points up — no flip option
    // exists, so the canonical side must be right.
    expect(seed.dir[2]).toBeCloseTo(1, 6);
    expect(seed.convex).toBe(true);
    expect(seed.bounds).toBeDefined();
    const extents = span(seed.bounds!).sort((a, b) => a - b);
    expect(extents[0]).toBeCloseTo(20, 4);
    expect(extents[1]).toBeCloseTo(40, 4);
    // Sharp 90° edges all around — the propagation chain is the seed alone.
    expect(data.chain).toHaveLength(1);
    expect(data.chain[0].form).toBe("plane");
  });

  it("classifies a shaft wall: cylinder, convex, full angular bounds, axial span", () => {
    part("shaft", () => {
      cylinder(10, 30);
      expose("wall", select(face().cylinder()));
    });
    const { data } = renderExposure("wall");

    const seed = data.seed!;
    expect(seed.form).toBe("cylinder");
    expect(seed.radius).toBeCloseTo(10, 6);
    expect(seed.convex).toBe(true);
    expect(Math.abs(seed.dir[2])).toBeCloseTo(1, 6);
    const [uSpan, vSpan] = span(seed.bounds!);
    expect(uSpan).toBeGreaterThanOrEqual(TWO_PI - 1e-6);
    expect(vSpan).toBeCloseTo(30, 4);
    expect(data.chain).toHaveLength(1);
  });

  it("classifies a bore wall as concave (shaft-in-bore internal branch input)", () => {
    part("plate", () => {
      sketch("xy", () => { testRect(40, 40); });
      const e = extrude(10);
      sketch(e.endFaces(), () => { circle([0, 0], 20); }); // Ø20 hole
      cut();
      // face().cylinder() requires a closed circular boundary edge, which a
      // cut bore (two arcs + seam) doesn't have — notPlanar() picks the wall.
      expose("bore", select(face().notPlanar()));
    });
    const { scene, data } = renderExposure("bore");
    {
      const solid = findSolid(scene);
      console.log("faces:", Explorer.findFacesWrapped(solid).map(f => classifyContactShape(f)?.form ?? "null"));
      const exposed = scene.getAllSceneObjects().find((o): o is Exposed => o instanceof Exposed)!;
      console.log("source shapes:", exposed.source.getShapes().map(s => s.getType()));
    }

    const seed = data.seed!;
    expect(seed.form).toBe("cylinder");
    expect(seed.radius).toBeCloseTo(10, 6);
    expect(seed.convex).toBe(false);
  });

  it("classifies a sphere face: center, radius, convex", () => {
    part("ball", () => {
      sphere(15);
      expose("skin", select(face()));
    });
    const { data } = renderExposure("skin");

    const seed = data.seed!;
    expect(seed.form).toBe("sphere");
    expect(seed.radius).toBeCloseTo(15, 6);
    expect(seed.convex).toBe(true);
    expect(seed.point[0]).toBeCloseTo(0, 4);
    expect(seed.point[1]).toBeCloseTo(0, 4);
  });

  it("walks the G1 chain of a rounded slab: top plane + 4 fillets + 4 sides", () => {
    part("slab", () => {
      sketch("xy", () => { testRect(40, 20); });
      const e = extrude(10);
      fillet(3, e.endEdges());
      expose("top", select(face().planar().onPlane("xy", 10)));
    });
    const { data } = renderExposure("top");

    expect(data.seed!.form).toBe("plane");
    expect(data.chain[0].form).toBe("plane");
    const cylinders = data.chain.filter(c => c.form === "cylinder");
    const planes = data.chain.filter(c => c.form === "plane");
    expect(cylinders).toHaveLength(4);
    for (const c of cylinders) {
      expect(c.radius).toBeCloseTo(3, 6);
      expect(c.convex).toBe(true);
    }
    // The fillets are G1 with the side walls too, so the walk continues to
    // them and stops at the sharp bottom edges: top + 4 sides.
    expect(planes).toHaveLength(5);
  });

  it("classifies a circular edge with full angular bounds", () => {
    part("disc", () => {
      cylinder(10, 30);
      expose("rim", select(edge().onPlane("xy", 30)));
    });
    const { data } = renderExposure("rim");

    const seed = data.seed!;
    expect(seed.form).toBe("circle");
    expect(seed.radius).toBeCloseTo(10, 6);
    expect(seed.point[2]).toBeCloseTo(30, 4);
    expect(seed.bounds!.uMax - seed.bounds!.uMin).toBeGreaterThanOrEqual(TWO_PI - 1e-6);
  });

  it("classifies a straight edge with its param interval", () => {
    part("box", () => {
      sketch("xy", () => { testRect(40, 20); });
      extrude(10);
      expose("lip", select(edge().onPlane("xy", 10)));
    });
    const { data } = renderExposure("lip");

    const seed = data.seed!;
    expect(seed.form).toBe("line");
    const uSpan = seed.bounds!.uMax - seed.bounds!.uMin;
    // One of the top rectangle edges — 40 or 20 depending on filter order.
    expect([20, 40].some(l => Math.abs(uSpan - l) < 1e-4)).toBe(true);
  });

  it("serializes seed: null for an unsupported surface form (torus)", () => {
    part("ring", () => {
      sketch("xz", () => { circle([30, 0], 10); });
      revolve("z");
      expose("skin", select(face()));
    });
    const { data } = renderExposure("skin");

    expect(data.seed).toBeNull();
    expect(data.chain).toEqual([]);
  });

  it("classifyContactShape returns null for non-face/edge shapes", () => {
    sketch("xy", () => { testRect(10, 10); });
    extrude(5);
    const scene = render();
    const solid = findSolid(scene);
    expect(classifyContactShape(solid)).toBeNull();
  });
});
