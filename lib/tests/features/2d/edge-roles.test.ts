import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import fillet from "../../../core/fillet.js";
import repeat from "../../../core/repeat.js";
import { mirror } from "../../../core/index.js";
import { rect, polygon, slot, circle, hLine, vLine, move, connect, offset } from "../../../core/2d/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Rect } from "../../../features/2d/rect.js";
import { Polygon } from "../../../features/2d/polygon.js";
import { Slot } from "../../../features/2d/slot.js";
import { Circle } from "../../../features/2d/circle.js";
import { Connect } from "../../../features/2d/connect.js";
import { Offset } from "../../../features/2d/offset.js";
import { HorizontalLine } from "../../../features/2d/hline.js";
import { MirrorShape2D } from "../../../features/mirror-shape2d.js";
import { Fillet2D } from "../../../features/fillet2d.js";
import { Extrude } from "../../../features/extrude.js";
import { Edge } from "../../../common/edge.js";
import { EdgeQuery } from "../../../oc/edge-query.js";
import { ShapeProps } from "../../../oc/props.js";

// Stage 1 (plans/sketch-edge-selection): every sketch edge carries
// {role, roleIndex?} + provenance on the Shape, serialized to the UI, with a
// uniform edge(role) accessor usable as an op target.
describe("edge roles", () => {
  setupOC();

  const edgesOf = (obj: { getShapes(): any[] }): Edge[] =>
    obj.getShapes().filter((s: any): s is Edge => s instanceof Edge);

  describe("primitive role stamping", () => {
    it("stamps rect sides", () => {
      let r: Rect;
      sketch("xy", () => {
        r = rect(80, 60) as Rect;
      });
      render();

      const roles = edgesOf(r).map(e => e.role);
      expect(roles).toEqual(['bottom', 'right', 'top', 'left']);
    });

    it("stamps rounded-rect sides and indexed corner arcs", () => {
      let r: Rect;
      sketch("xy", () => {
        r = (rect(80, 60) as Rect).radius(10);
      });
      render();

      const edges = edgesOf(r);
      expect(edges).toHaveLength(8);

      const sides = edges.filter(e => e.role !== 'corner-arc').map(e => e.role);
      expect(sides.sort()).toEqual(['bottom', 'left', 'right', 'top']);

      const arcIndices = edges.filter(e => e.role === 'corner-arc').map(e => e.roleIndex);
      expect(arcIndices.sort()).toEqual([0, 1, 2, 3]);
    });

    it("stamps polygon sides with indices", () => {
      let p: Polygon;
      sketch("xy", () => {
        p = polygon(6, 60) as Polygon;
      });
      render();

      const edges = edgesOf(p);
      expect(edges).toHaveLength(6);
      edges.forEach(e => expect(e.role).toBe('side'));
      expect(edges.map(e => e.roleIndex).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("stamps slot sides and cap arcs", () => {
      let s: Slot;
      sketch("xy", () => {
        s = slot(80, 15) as Slot;
      });
      render();

      const edges = edgesOf(s);
      expect(edges).toHaveLength(4);
      const byRole = new Map<string, number[]>();
      for (const e of edges) {
        byRole.set(e.role!, [...(byRole.get(e.role!) ?? []), e.roleIndex!]);
      }
      expect(byRole.get('side')!.sort()).toEqual([0, 1]);
      expect(byRole.get('cap-arc')!.sort()).toEqual([0, 1]);
    });

    it("stamps circle perimeter and single-edge primitives as body", () => {
      let c: Circle;
      let h: HorizontalLine;
      sketch("xy", () => {
        c = circle(40) as Circle;
        move([60, 0]);
        h = hLine(30) as HorizontalLine;
      });
      render();

      expect(edgesOf(c)[0].role).toBe('perimeter');
      expect(edgesOf(h)[0].role).toBe('body');
    });
  });

  describe("serialization to the rendered scene", () => {
    it("carries role/roleIndex/provenance and interactivity to RenderedShape", () => {
      let r: Rect;
      let o: Offset;
      const s = sketch("xy", () => {
        r = rect(80, 60) as Rect;
        o = offset(5) as Offset;
      }) as Sketch;

      const scene = render();

      const renderedRect = scene.getRenderedObject(r)!;
      const roles = renderedRect.sceneShapes.map(sh => sh.role);
      expect(roles).toEqual(['bottom', 'right', 'top', 'left']);
      expect(renderedRect.interactivity).toBe('draggable');

      const renderedOffset = scene.getRenderedObject(o)!;
      expect(renderedOffset.interactivity).toBe('selectable');
      const provenance = renderedOffset.sceneShapes.map(sh => sh.provenance);
      provenance.forEach(p => expect(p).toBe('offset-of'));

      expect(scene.getRenderedObject(s)!.interactivity).toBeUndefined();
    });
  });

  describe("accessor as fillet target", () => {
    it("fillets the corner between two accessor-selected rect edges", () => {
      let r: Rect;
      let f: Fillet2D;
      const s = sketch("xy", () => {
        r = rect(80, 60) as Rect;
        f = fillet(4, r.edge('top'), r.edge('left')) as Fillet2D;
      }) as Sketch;

      render();

      // The fillet owns trimmed top + corner arc + trimmed left.
      const filletEdges = edgesOf(f);
      expect(filletEdges).toHaveLength(3);

      const arcs = filletEdges.filter(edge => EdgeQuery.getEdgeCurveType(edge) === 'circle');
      expect(arcs).toHaveLength(1);
      expect(arcs[0].provenance).toBe('fillet-arc');

      // Trimmed survivors keep their construction roles.
      const survivorRoles = filletEdges
        .filter(edge => EdgeQuery.getEdgeCurveType(edge) === 'line')
        .map(edge => edge.role);
      expect(survivorRoles.sort()).toEqual(['left', 'top']);

      // The rect no longer renders the replaced originals.
      const rectRoles = edgesOf(r).map(edge => edge.role);
      expect(rectRoles.sort()).toEqual(['bottom', 'right']);

      // No double counting through the lazy accessor children.
      const edgeMap = s.getEdgesWithOwner();
      expect(edgeMap.size).toBe(5);
      for (const owner of edgeMap.values()) {
        expect(owner.isLazy()).toBe(false);
      }
    });

    it("extrudes an accessor-filleted profile into the exact solid", () => {
      sketch("xy", () => {
        const r = rect(80, 60) as Rect;
        fillet(4, r.edge('top'), r.edge('left'));
      });

      const e = extrude(10) as Extrude;
      render();

      const solids = e.getShapes();
      expect(solids).toHaveLength(1);
      expect(solids[0].getType()).toBe("solid");

      // Rect area minus the filleted corner: w*h - (r² - πr²/4), r=4.
      const expected = (80 * 60 - (16 - Math.PI * 16 / 4)) * 10;
      const props = ShapeProps.getProperties(solids[0].getShape());
      expect(props.volumeMm3).toBeCloseTo(expected, 1);
    });

    it("named rect accessors delegate to the role accessor", () => {
      let r: Rect;
      let f: Fillet2D;
      sketch("xy", () => {
        r = rect(80, 60) as Rect;
        f = fillet(5, r.topEdge(), r.rightEdge()) as Fillet2D;
      });
      render();

      const arcs = edgesOf(f).filter(edge => EdgeQuery.getEdgeCurveType(edge) === 'circle');
      expect(arcs).toHaveLength(1);
    });
  });

  describe("whole-sketch fillet chain (rect → fillet2d)", () => {
    it("keeps side roles on trimmed edges and stamps fillet-arc on corners", () => {
      let f: Fillet2D;
      sketch("xy", () => {
        rect(80, 60);
        f = fillet(6) as Fillet2D;
      });
      render();

      const edges = edgesOf(f);
      expect(edges).toHaveLength(8);

      const arcs = edges.filter(edge => edge.provenance === 'fillet-arc');
      expect(arcs).toHaveLength(4);

      const sideRoles = edges.filter(edge => edge.provenance !== 'fillet-arc').map(edge => edge.role);
      expect(sideRoles.sort()).toEqual(['bottom', 'left', 'right', 'top']);
    });
  });

  describe("roles survive transforms", () => {
    it("mirror2d copies keep roles and gain mirror-copy provenance", () => {
      let m: MirrorShape2D;
      sketch("xy", () => {
        move([10, 0]);
        rect(40, 30);
        m = mirror("y") as MirrorShape2D;
      });
      render();

      const copies = edgesOf(m);
      expect(copies).toHaveLength(4);
      expect(copies.map(e => e.role).sort()).toEqual(['bottom', 'left', 'right', 'top']);
      copies.forEach(e => expect(e.provenance).toBe('mirror-copy'));
    });

    it("cloned sketches (repeat) keep roles on transformed edges", () => {
      const s = sketch("xy", () => {
        rect(40, 30);
      }) as Sketch;

      const e = extrude(10);
      repeat("linear", "x", { count: 2, offset: 60 }, e as any);

      const scene = render();

      const sketches = scene.getAllSceneObjects().filter(o => o instanceof Sketch) as Sketch[];
      const clones = sketches.filter(sk => sk !== s && sk.getCloneSource());
      expect(clones.length).toBeGreaterThan(0);

      // The cloned extrude consumes (removes) the cloned sketch's edges, so
      // inspect the raw added shapes for role survival.
      for (const clone of clones) {
        const roles = clone.getChildren()
          .flatMap(child => child.getAddedShapes())
          .filter((shape): shape is Edge => shape instanceof Edge && !shape.isMetaShape())
          .map(edge => edge.role);
        expect(roles.sort()).toEqual(['bottom', 'left', 'right', 'top']);
      }
    });
  });

  describe("connect provenance", () => {
    it("stamps bridges and keeps body roles on re-emitted edges", () => {
      let c: Connect;
      sketch("xy", () => {
        hLine(80);
        move([90, 20]);
        vLine(40);
        c = connect() as Connect;
      });
      render();

      const edges = edgesOf(c);
      expect(edges).toHaveLength(4);

      const bridges = edges.filter(edge => edge.provenance === 'bridge');
      expect(bridges).toHaveLength(2);

      const bodies = edges.filter(edge => edge.provenance !== 'bridge');
      bodies.forEach(edge => expect(edge.role).toBe('body'));
    });
  });
});
