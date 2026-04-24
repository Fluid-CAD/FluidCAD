import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import revolve from "../../core/revolve.js";
import sweep from "../../core/sweep.js";
import loft from "../../core/loft.js";
import extrude from "../../core/extrude.js";
import cylinder from "../../core/cylinder.js";
import plane from "../../core/plane.js";
import { move, rect, circle, vLine } from "../../core/2d/index.js";
import { Revolve } from "../../features/revolve.js";
import { Sweep } from "../../features/sweep.js";
import { Loft } from "../../features/loft.js";
import { ExtrudeTwoDistances } from "../../features/extrude-two-distances.js";
import { Cylinder } from "../../features/cylinder.js";

describe("Revolve — history tracking", () => {
  setupOC();

  it("records added faces/edges and finalShapes on a plain revolve into empty scene", () => {
    sketch("xz", () => {
      move([20, 0]);
      rect(10, 30);
    });
    const r = revolve("z") as Revolve;
    render();

    expect(r.getAddedFaces().length).toBeGreaterThan(0);
    expect(r.getAddedEdges().length).toBeGreaterThan(0);
    expect(r.getModifiedFaces()).toEqual([]);
    expect(r.getRemovedFaces()).toEqual([]);
    expect(r.getFinalShapes().length).toBeGreaterThan(0);
  });

  it("pre-computes edge categories in state after revolve build", () => {
    sketch("xz", () => {
      move([20, 0]);
      rect(10, 30);
    });
    const r = revolve("z", 90) as Revolve;
    render();

    expect(r.getState('start-edges')).toBeDefined();
    expect(r.getState('end-edges')).toBeDefined();
    expect(r.getState('side-edges')).toBeDefined();
  });

  it("attributes modifications to the scene object when revolve fuses with it", () => {
    const c = cylinder(30, 40) as Cylinder;

    sketch("xz", () => {
      move([20, 0]);
      rect(8, 20);
    });
    const r = revolve("z") as Revolve;
    render();

    const modified = c.getModifiedFaces();
    expect(modified.length).toBeGreaterThan(0);
    for (const record of modified) {
      expect(record.modifiedBy).toBe(r);
    }
    expect(r.getAddedFaces().length).toBeGreaterThan(0);
  });
});

describe("Sweep — history tracking", () => {
  setupOC();

  it("records added faces/edges and finalShapes on a plain sweep into empty scene", () => {
    const profile = sketch("xy", () => {
      circle(10);
    });

    const path = sketch("xz", () => {
      vLine(50);
    });

    const s = sweep(path, profile) as Sweep;
    render();

    expect(s.getAddedFaces().length).toBeGreaterThan(0);
    expect(s.getAddedEdges().length).toBeGreaterThan(0);
    expect(s.getFinalShapes().length).toBeGreaterThan(0);
    expect(s.getState('side-edges')).toBeDefined();
  });
});

describe("Loft — history tracking", () => {
  setupOC();

  it("records added faces/edges and finalShapes on a plain loft into empty scene", () => {
    const s1 = sketch("xy", () => {
      rect(20, 20);
    });
    const p = plane("xy", { offset: 50 });
    const s2 = sketch(p, () => {
      circle(10);
    });

    const l = loft(s1, s2) as Loft;
    render();

    expect(l.getAddedFaces().length).toBeGreaterThan(0);
    expect(l.getAddedEdges().length).toBeGreaterThan(0);
    expect(l.getFinalShapes().length).toBeGreaterThan(0);
    expect(l.getState('side-edges')).toBeDefined();
  });
});

describe("ExtrudeToFace — history tracking", () => {
  setupOC();

  it("records added faces/edges and finalShapes into empty scene via 'last-face'", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    extrude(30);

    sketch("xy", () => {
      rect(20, 20);
    });
    const e = extrude("last-face") as unknown as {
      getAddedFaces(): any[];
      getAddedEdges(): any[];
      getFinalShapes(): any[];
      getState(k: string): any;
    };
    render();

    expect(e.getAddedFaces().length).toBeGreaterThan(0);
    expect(e.getAddedEdges().length).toBeGreaterThan(0);
    expect(e.getFinalShapes().length).toBeGreaterThan(0);
    expect(e.getState('side-edges')).toBeDefined();
  });
});

describe("ExtrudeTwoDistances — history tracking", () => {
  setupOC();

  it("records added faces/edges and finalShapes into empty scene", () => {
    sketch("xy", () => {
      rect(40, 30);
    });
    const e2 = extrude(20, 10) as ExtrudeTwoDistances;
    render();

    expect(e2.getAddedFaces().length).toBeGreaterThan(0);
    expect(e2.getAddedEdges().length).toBeGreaterThan(0);
    expect(e2.getFinalShapes().length).toBeGreaterThan(0);
    expect(e2.getState('side-edges')).toBeDefined();
  });
});
