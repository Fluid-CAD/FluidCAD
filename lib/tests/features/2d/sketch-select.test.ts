import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import fillet from "../../../core/fillet.js";
import select from "../../../core/select.js";
import fuse from "../../../core/fuse.js";
import { rect, circle, slot, move, offset } from "../../../core/2d/index.js";
import { edge, face } from "../../../filters/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { SelectSceneObject } from "../../../features/select.js";
import { Rect } from "../../../features/2d/rect.js";
import { Fillet2D } from "../../../features/fillet2d.js";
import { Fuse2D } from "../../../features/fuse2d.js";
import { Offset } from "../../../features/2d/offset.js";
import { Edge } from "../../../common/edge.js";
import { Extrude } from "../../../features/extrude.js";
import { EdgeQuery } from "../../../oc/edge-query.js";

// Stage 2 (plans/sketch-edge-selection): sketch-scoped select() and edge
// filters as direct 2D-op arguments.
describe("sketch-scoped selection", () => {
  setupOC();

  const edgesOf = (obj: { getShapes(): any[] }): Edge[] =>
    obj.getShapes().filter((s: any): s is Edge => s instanceof Edge);

  describe("select(edge()...) inside a sketch", () => {
    it("evaluates against the active sketch's edges", () => {
      let sel: SelectSceneObject;
      sketch("xy", () => {
        slot(80, 15);
        sel = select(edge().arc()) as SelectSceneObject;
      });
      render();

      // The slot's two cap arcs, nothing else.
      const selected = edgesOf(sel);
      expect(selected).toHaveLength(2);
      selected.forEach(e => expect(e.role).toBe('cap-arc'));
    });

    it("does not steal edge ownership or double-count", () => {
      let r: Rect;
      const s = sketch("xy", () => {
        r = rect(80, 60) as Rect;
        select(edge().line());
      }) as Sketch;
      render();

      const edgeMap = s.getEdgesWithOwner();
      expect(edgeMap.size).toBe(4);
      for (const owner of edgeMap.values()) {
        expect(owner).toBe(r);
      }
    });

    it("rejects face filters inside a sketch", () => {
      let sel: SelectSceneObject;
      sketch("xy", () => {
        rect(80, 60);
        sel = select(face().parallelTo("xy")) as SelectSceneObject;
      });
      render();

      expect(sel.getError()).toMatch(/not supported inside a sketch/);
    });
  });

  describe("last-selection consumption by 2D ops", () => {
    it("fillet(radius) consumes a sketch-scoped selection", () => {
      let f: Fillet2D;
      sketch("xy", () => {
        rect(80, 60);
        select(edge().line());
        f = fillet(6) as Fillet2D;
      });
      const e = extrude(10) as Extrude;
      render();

      // The extrude consumes (removes) the sketch edges — inspect raw adds.
      const arcs = f.getAddedShapes()
        .filter((shape): shape is Edge => shape instanceof Edge)
        .filter(edge => edge.provenance === 'fillet-arc');
      expect(arcs).toHaveLength(4);

      // Profile still extrudes after selection-driven filleting.
      expect(e.getShapes()[0].getType()).toBe("solid");
    });

    it("offset(distance) consumes a sketch-scoped selection", () => {
      let o: Offset;
      const s = sketch("xy", () => {
        circle(40);
        move([100, 0]);
        rect(20, 20);
        select(edge().circle());
        o = offset(5) as Offset;
      }) as Sketch;
      render();

      // Only the circle got offset: one new perimeter edge.
      const offsetEdges = edgesOf(o);
      expect(offsetEdges).toHaveLength(1);
      expect(EdgeQuery.isCircleEdge(offsetEdges[0], 50)).toBe(true);

      // Originals untouched: circle + 4 rect sides + offset result.
      expect(s.getEdgesWithOwner().size).toBe(6);
    });

    it("fuse() consumes a sketch-scoped selection", () => {
      let fu: Fuse2D;
      const s = sketch("xy", () => {
        circle(40);
        move([30, 0]);
        circle(40);
        select(edge().circle());
        fu = fuse() as Fuse2D;
      }) as Sketch;
      render();

      // Two overlapping circles fuse into one outline owned by the fuse.
      const fusedEdges = edgesOf(fu);
      expect(fusedEdges.length).toBeGreaterThan(0);
      const edgeMap = s.getEdgesWithOwner();
      for (const owner of edgeMap.values()) {
        expect(owner).toBe(fu);
      }
    });
  });

  describe("edge filters as direct op arguments", () => {
    it("fillet(4, edge().line()) fillets the filtered group's corners", () => {
      let f: Fillet2D;
      sketch("xy", () => {
        rect(80, 60);
        f = fillet(4, edge().line()) as Fillet2D;
      });
      render();

      const edges = edgesOf(f);
      expect(edges).toHaveLength(8);
      expect(edges.filter(edge => edge.provenance === 'fillet-arc')).toHaveLength(4);
    });

    it("filters skip non-matching geometry", () => {
      let f: Fillet2D;
      const s = sketch("xy", () => {
        circle(40);
        move([100, 0]);
        rect(30, 30);
        f = fillet(4, edge().line()) as Fillet2D;
      }) as Sketch;
      render();

      // Only the rect participates; the circle stays untouched.
      const arcs = edgesOf(f).filter(edge => edge.provenance === 'fillet-arc');
      expect(arcs).toHaveLength(4);

      const roles = [...s.getEdgesWithOwner().keys()].map(edge => edge.role);
      expect(roles).toContain('perimeter');
    });

    it("offset accepts an explicit feature target in a sketch", () => {
      let o: Offset;
      sketch("xy", () => {
        const c = circle(40);
        move([100, 0]);
        rect(20, 20);
        o = offset(5, c) as Offset;
      });
      render();

      const offsetEdges = edgesOf(o);
      expect(offsetEdges).toHaveLength(1);
      expect(EdgeQuery.isCircleEdge(offsetEdges[0], 50)).toBe(true);
    });

    it("mixes accessors and filters in one target list", () => {
      let f: Fillet2D;
      sketch("xy", () => {
        const r = rect(80, 60) as Rect;
        f = fillet(5, r.edge('top'), edge().line()) as Fillet2D;
      });
      render();

      // Union = the whole rect outline → all four corners rounded.
      const arcs = edgesOf(f).filter(edge => edge.provenance === 'fillet-arc');
      expect(arcs).toHaveLength(4);
    });
  });

  describe("stability across rebuilds", () => {
    it("filter-target ops compare equal when rebuilt identically", () => {
      const a = new Fillet2D(4, edge().line());
      const b = new Fillet2D(4, edge().line());
      const c = new Fillet2D(4, edge().arc());
      expect(a.compareTo(b)).toBe(true);
      expect(a.compareTo(c)).toBe(false);
    });

    it("sketch selections compare equal when rebuilt identically", () => {
      const a = new SelectSceneObject([edge().arc()]);
      const b = new SelectSceneObject([edge().arc()]);
      const c = new SelectSceneObject([edge().line()]);
      expect(a.compareTo(b)).toBe(true);
      expect(a.compareTo(c)).toBe(false);
    });
  });
});
