import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cylinder from "../../core/cylinder.js";
import { circle, rect } from "../../core/2d/index.js";
import { Extrude } from "../../features/extrude.js";
import { Cylinder } from "../../features/cylinder.js";

describe("extrude — history tracking (Phase 2b: finalShapes)", () => {
  setupOC();

  it("populates finalShapes with the extruded solid on a plain extrude", () => {
    sketch("xy", () => {
      rect(100, 50);
    });

    const e = extrude(30) as Extrude;
    render();

    const finals = e.getFinalShapes();
    const visible = e.getShapes();

    expect(finals).toHaveLength(1);
    expect(finals[0].getType()).toBe("solid");
    // finalShapes should match what the scene would render for this op.
    expect(finals).toEqual(visible);
  });

  it("populates finalShapes on a symmetric extrude", () => {
    sketch("xy", () => {
      rect(40, 40);
    });

    const e = extrude(20).symmetric() as Extrude;
    render();

    const finals = e.getFinalShapes();
    expect(finals).toHaveLength(1);
    expect(finals[0].getType()).toBe("solid");
    expect(finals).toEqual(e.getShapes());
  });

  it("populates finalShapes on a cut (remove) extrude", () => {
    sketch("xy", () => {
      rect(100, 100);
    });
    extrude(40);

    sketch("xy", () => {
      rect(20, 20);
    });
    const cut = extrude(10).remove() as Extrude;

    render();

    const finals = cut.getFinalShapes();
    expect(finals).toEqual(cut.getShapes());
    // The cut should have produced at least one surviving solid.
    expect(finals.length).toBeGreaterThan(0);
    for (const s of finals) {
      expect(s.getType()).toBe("solid");
    }
  });
});

describe("extrude — history tracking (Phase 2c: added/modified lineage)", () => {
  setupOC();

  it("records every face of a plain extrude as addedFaces on the extrude op", () => {
    sketch("xy", () => {
      rect(40, 30);
    });
    const e = extrude(10) as Extrude;
    render();

    const added = e.getAddedFaces();
    // A rectangular extrusion has 6 faces (start, end, 4 sides).
    expect(added).toHaveLength(6);
    // No modifications on an empty-scene extrude.
    expect(e.getModifiedFaces()).toEqual([]);
    expect(e.getRemovedFaces()).toEqual([]);
  });

  it("records added edges on a plain extrude", () => {
    sketch("xy", () => {
      rect(40, 30);
    });
    const e = extrude(10) as Extrude;
    render();

    // A rectangular extrusion has 12 edges (4 on start, 4 on end, 4 verticals).
    expect(e.getAddedEdges()).toHaveLength(12);
  });

  it("attributes modifications to the existing scene object when fusing with it", () => {
    const c = cylinder(20, 20) as Cylinder;

    sketch("xy", () => {
      circle([0, 0], 20);
    });
    const e = extrude(40) as Extrude;
    render();

    // The cylinder's faces should get modified by the fusion — record lineage on c.
    const modified = c.getModifiedFaces();
    expect(modified.length).toBeGreaterThan(0);

    // Every modification's modifiedBy is the extrude.
    for (const record of modified) {
      expect(record.modifiedBy).toBe(e);
      expect(record.sources.length).toBeGreaterThan(0);
      expect(record.results.length).toBeGreaterThan(0);
    }
  });

  it("records added faces on the extrude for faces that came from the extrusion tool", () => {
    cylinder(20, 20) as Cylinder;

    sketch("xy", () => {
      circle([0, 0], 20);
    });
    const e = extrude(40) as Extrude;
    render();

    // Some faces in the fused result didn't come from the cylinder — they come
    // from the extrusion. Those should show up as additions on the extrude.
    expect(e.getAddedFaces().length).toBeGreaterThan(0);
  });

  it("records added faces/edges on a symmetric extrude in an empty scene", () => {
    sketch("xy", () => {
      rect(40, 30);
    });
    const e = extrude(10).symmetric() as Extrude;
    render();

    // Symmetric extrusion fuses two half-prisms; SimplifyResult keeps
    // face count at 6 for a box but may leave seam edges along the symmetry
    // plane, so edge count is >= 12 rather than exactly 12.
    expect(e.getAddedFaces().length).toBeGreaterThanOrEqual(6);
    expect(e.getAddedEdges().length).toBeGreaterThanOrEqual(12);
    expect(e.getModifiedFaces()).toEqual([]);
    expect(e.getRemovedFaces()).toEqual([]);
  });

  it("attributes modifications on the existing scene object for a symmetric extrude fused with it", () => {
    const c = cylinder(30, 40) as Cylinder;

    sketch("xy", () => {
      circle([0, 0], 20);
    });
    const e = extrude(60).symmetric() as Extrude;
    render();

    const modified = c.getModifiedFaces();
    expect(modified.length).toBeGreaterThan(0);
    for (const record of modified) {
      expect(record.modifiedBy).toBe(e);
    }
    expect(e.getAddedFaces().length).toBeGreaterThan(0);
  });

  it("classified start faces survive fusion (remap through tool history)", () => {
    // Place a cylinder so the extrude's start face gets fused into it.
    cylinder(25, 5) as Cylinder;

    sketch("xy", () => {
      circle([0, 0], 25);
    });
    const e = extrude(30) as Extrude;
    render();

    // After fusion, the stored start-faces must be faces that actually exist
    // on the final fused solid. Compare TShape pointers via IsSame.
    const storedStart = e.getState('start-faces') as unknown as { getShape(): any }[] | undefined;
    expect(storedStart).toBeDefined();
    expect(storedStart!.length).toBeGreaterThan(0);

    const finalSolid = e.getFinalShapes()[0];
    expect(finalSolid).toBeDefined();

    const finalFaceRaws = finalSolid.getSubShapes("face").map(f => f.getShape());
    for (const sf of storedStart!) {
      const raw = sf.getShape();
      const match = finalFaceRaws.some(ff => ff.IsSame(raw));
      expect(match).toBe(true);
    }
  });

  it("startFaces() selection resolves to a real face after fusion", () => {
    cylinder(25, 5) as Cylinder;

    sketch("xy", () => {
      circle([0, 0], 25);
    });
    const e = extrude(30) as Extrude;

    const sf = e.startFaces();
    addToScene(sf);
    render();

    const resolved = sf.getShapes();
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved[0].getType()).toBe("face");
  });

  it("records cut history: modified stock faces on the scene object and added section faces on the cut", () => {
    sketch("xy", () => {
      rect(100, 100);
    });
    const stock = extrude(40) as Extrude;

    sketch("xy", () => {
      rect(20, 20);
    });
    const cut = extrude(15).remove() as Extrude;
    render();

    // The stock's faces are modified by the cut — at least some faces
    // should be trimmed, so expect modifications attributed to `cut`.
    const modified = stock.getModifiedFaces();
    expect(modified.length).toBeGreaterThan(0);
    for (const record of modified) {
      expect(record.modifiedBy).toBe(cut);
    }

    // The cut creates new section faces/edges that don't exist on the stock.
    expect(cut.getAddedFaces().length).toBeGreaterThan(0);
  });

  it("edge classification is pre-computed in state after build (not derived lazily)", () => {
    sketch("xy", () => {
      rect(40, 30);
    });
    const e = extrude(10) as Extrude;
    render();

    // All five edge categories should be in state after build. side-edges is
    // the one that used to be derived lazily on every sideEdges() call —
    // now it's pre-computed.
    expect(e.getState('start-edges')).toBeDefined();
    expect(e.getState('end-edges')).toBeDefined();
    expect(e.getState('side-edges')).toBeDefined();
    expect(e.getState('internal-edges')).toBeDefined();
    expect(e.getState('cap-edges')).toBeDefined();

    // Side edges of a plain rectangular extrude are the 4 verticals.
    const sideEdges = e.getState('side-edges') as any[];
    expect(sideEdges).toHaveLength(4);
  });

  it("sideEdges selection agrees with pre-computed side-edges state", () => {
    sketch("xy", () => {
      rect(40, 30);
    });
    const e = extrude(10) as Extrude;

    const sel = e.sideEdges();
    addToScene(sel);
    render();

    const selected = sel.getShapes();
    const classified = e.getState('side-edges') as any[];
    expect(selected).toHaveLength(classified.length);
    for (const s of selected) {
      const match = classified.some(c => c.getShape().IsSame(s.getShape()));
      expect(match).toBe(true);
    }
  });

  it("modified cut result faces point at post-clean faces (UnifySameDomain lineage)", () => {
    // Through-all cut usually triggers UnifySameDomain merges where the cut
    // passes through the stock and the surrounding face topology simplifies.
    sketch("xy", () => {
      rect(100, 100);
    });
    const stock = extrude(40) as Extrude;

    sketch("xy", () => {
      rect(20, 20);
    });
    const cut = extrude(0).remove() as Extrude;
    render();

    const finalSolid = cut.getFinalShapes()[0];
    expect(finalSolid).toBeDefined();
    const finalFaceRaws = finalSolid!.getSubShapes("face").map(f => f.getShape());

    // Every result face in every modification record should be a face that
    // actually exists on the final (post-clean) solid. If the chaining were
    // broken, pre-clean faces would show up here and fail IsSame checks.
    const modified = stock.getModifiedFaces();
    expect(modified.length).toBeGreaterThan(0);
    for (const record of modified) {
      for (const result of record.results) {
        const match = finalFaceRaws.some(f => f.IsSame(result.getShape()));
        expect(match).toBe(true);
      }
    }
  });
});
