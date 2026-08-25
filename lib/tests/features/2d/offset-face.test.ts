import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import select from "../../../core/select.js";
import { circle, move, offset, rect } from "../../../core/2d/index.js";
import { Extrude } from "../../../features/extrude.js";
import { Offset } from "../../../features/2d/offset.js";
import { Edge } from "../../../common/edge.js";
import { Solid } from "../../../common/solid.js";
import { ShapeOps } from "../../../oc/shape-ops.js";
import { face } from "../../../filters/index.js";
import { SelectSceneObject } from "../../../features/select.js";

function overallBBox(edges: Edge[]) {
  const bbox = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const edge of edges) {
    const b = ShapeOps.getBoundingBox(edge);
    bbox.minX = Math.min(bbox.minX, b.minX);
    bbox.minY = Math.min(bbox.minY, b.minY);
    bbox.minZ = Math.min(bbox.minZ, b.minZ);
    bbox.maxX = Math.max(bbox.maxX, b.maxX);
    bbox.maxY = Math.max(bbox.maxY, b.maxY);
    bbox.maxZ = Math.max(bbox.maxZ, b.maxZ);
  }
  return bbox;
}

describe("offset from faces", () => {
  setupOC();

  it("should offset a face outline outward on the face plane", () => {
    sketch("xy", () => {
      rect(100, 100);
    });
    const box = extrude(50) as Extrude;

    const off = offset(5, box.endFaces()) as unknown as Offset;

    render();

    const edges = off.getShapes().filter((s): s is Edge => s instanceof Edge);
    expect(edges.length).toBeGreaterThan(0);

    const bbox = overallBBox(edges);
    // Outline grows by the distance on every side and stays on the top plane.
    expect(bbox.minX).toBeCloseTo(-5, 0);
    expect(bbox.maxX).toBeCloseTo(105, 0);
    expect(bbox.minY).toBeCloseTo(-5, 0);
    expect(bbox.maxY).toBeCloseTo(105, 0);
    expect(bbox.minZ).toBeCloseTo(50, 0);
    expect(bbox.maxZ).toBeCloseTo(50, 0);

    const plane = off.getPlane();
    expect(Math.abs(plane.normal.z)).toBeCloseTo(1, 6);
    expect(plane.origin.z).toBeCloseTo(50, 6);
  });

  it("should offset inward with a negative distance", () => {
    sketch("xy", () => {
      rect(100, 100);
    });
    const box = extrude(50) as Extrude;

    const off = offset(-10, box.endFaces()) as unknown as Offset;

    render();

    const bbox = overallBBox(off.getShapes().filter((s): s is Edge => s instanceof Edge));
    expect(bbox.minX).toBeCloseTo(10, 0);
    expect(bbox.maxX).toBeCloseTo(90, 0);
    expect(bbox.minY).toBeCloseTo(10, 0);
    expect(bbox.maxY).toBeCloseTo(90, 0);
  });

  it("should shrink holes while growing the outer outline", () => {
    sketch("xy", () => {
      rect(100, 100);
      move([50, 50]);
      circle(40);
    });
    const box = extrude(50) as Extrude;

    const off = offset(5, box.endFaces()) as unknown as Offset;

    render();

    const edges = off.getShapes().filter((s): s is Edge => s instanceof Edge);
    const bbox = overallBBox(edges);
    expect(bbox.maxX - bbox.minX).toBeCloseTo(110, 0);

    // The r=20 hole shrinks to r=15 (region semantics: material grows).
    const holeEdge = edges.find(e => {
      const b = ShapeOps.getBoundingBox(e);
      return Math.abs((b.maxX - b.minX) - 30) < 0.5 && Math.abs((b.maxY - b.minY) - 30) < 0.5;
    });
    expect(holeEdge).toBeDefined();
  });

  it("should be extrudable like a sketch", () => {
    sketch("xy", () => {
      rect(100, 100);
    });
    const box = extrude(50) as Extrude;

    const off = offset(5, box.endFaces()) as unknown as Offset;
    const rim = extrude(10, off).new() as Extrude;

    render();

    const shapes = rim.getShapes();
    expect(shapes).toHaveLength(1);
    expect(shapes[0].getType()).toBe("solid");

    const bbox = ShapeOps.getBoundingBox(shapes[0]);
    expect(bbox.minZ).toBeCloseTo(50, 0);
    expect(bbox.maxZ).toBeCloseTo(60, 0);
    expect(bbox.maxX - bbox.minX).toBeCloseTo(110, 0);
    expect((shapes[0] as Solid).getFaces().length).toBeGreaterThan(5);
  });

  it("should use a preceding select as implicit target", () => {
    sketch("xy", () => {
      rect(100, 100);
    });
    extrude(50);

    select(face().onPlane("xy", 50));
    const off = offset(5) as unknown as Offset;

    render();

    expect(off.getError()).toBeFalsy();
    const bbox = overallBBox(off.getShapes().filter((s): s is Edge => s instanceof Edge));
    expect(bbox.maxX - bbox.minX).toBeCloseTo(110, 0);
    expect(bbox.minZ).toBeCloseTo(50, 0);
  });

  it("should offset multiple coplanar faces", () => {
    sketch("xy", () => {
      rect(50, 50);
    });
    extrude(30);

    sketch("xy", () => {
      move([100, 0]);
      rect(50, 50);
    });
    extrude(30);

    const sel = select(face().onPlane("xy", 30));
    const off = offset(5, sel) as unknown as Offset;

    render();

    expect(off.getError()).toBeFalsy();
    const bbox = overallBBox(off.getShapes().filter((s): s is Edge => s instanceof Edge));
    expect(bbox.minX).toBeCloseTo(-5, 0);
    expect(bbox.maxX).toBeCloseTo(155, 0);
    expect(bbox.minZ).toBeCloseTo(30, 0);
    expect(bbox.maxZ).toBeCloseTo(30, 0);
  });

  it("should consume an explicit select target", () => {
    sketch("xy", () => {
      rect(100, 100);
    });
    extrude(50);

    const sel = select(face().onPlane("xy", 50)) as SelectSceneObject;
    const off = offset(-2, sel) as unknown as Offset;

    render();

    expect(off.getError()).toBeFalsy();
    expect(off.getShapes().length).toBeGreaterThan(0);
    expect(sel.getShapes()).toHaveLength(0);
  });

  it("should consume the implicit preceding select", () => {
    sketch("xy", () => {
      rect(100, 100);
    });
    extrude(50);

    const sel = select(face().onPlane("xy", 50)) as SelectSceneObject;
    const off = offset(5) as unknown as Offset;

    render();

    expect(off.getError()).toBeFalsy();
    expect(sel.getShapes()).toHaveLength(0);
  });

  it("should not consume lazy face accessor targets", () => {
    sketch("xy", () => {
      rect(100, 100);
    });
    const box = extrude(50) as Extrude;

    const accessor = box.endFaces();
    const off = offset(5, accessor) as unknown as Offset;

    render();

    expect(off.getError()).toBeFalsy();
    expect(accessor.getShapes().length).toBeGreaterThan(0);
  });

  it("should reject non-coplanar face targets", () => {
    sketch("xy", () => {
      rect(100, 100);
    });
    extrude(50);

    const top = select(face().onPlane("xy", 50));
    const side = select(face().onPlane("yz", 100));
    const off = offset(5, top, side) as unknown as Offset;

    render();

    expect(off.getError()).toBeTruthy();
    expect(off.getError()).toContain("coplanar");
  });

  it("should reject the removed removeOriginal flag", () => {
    sketch("xy", () => {
      rect(100, 100);
    });
    const box = extrude(50) as Extrude;

    expect(() => (offset as any)(5, true, box.endFaces()))
      .toThrow(/no longer takes a removeOriginal flag/);
  });
});
