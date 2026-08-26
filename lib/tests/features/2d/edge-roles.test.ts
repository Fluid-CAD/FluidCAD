import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import fillet from "../../../core/fillet.js";
import repeat from "../../../core/repeat.js";
import { mirror } from "../../../core/index.js";
import { circle, line, offset } from "../../../core/2d/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Offset } from "../../../features/2d/offset.js";
import { MirrorShape2D } from "../../../features/mirror-shape2d.js";
import { Fillet2D } from "../../../features/fillet2d.js";
import { Extrude } from "../../../features/extrude.js";
import { Edge } from "../../../common/edge.js";
import { EdgeQuery } from "../../../oc/edge-query.js";
import { ShapeProps } from "../../../oc/props.js";
import { testRect } from "../../helpers/profiles.js";

// Stage 1 (plans/sketch-edge-selection): every sketch edge carries
// {role, roleIndex?} + provenance on the Shape, serialized to the UI.
// Since P7 the primitives are independent solver entities: lines stamp
// 'body', circles 'perimeter'; the richer per-primitive roles left with the
// legacy classes.
describe("edge roles", () => {
  setupOC();

  const edgesOf = (obj: { getShapes(): any[] }): Edge[] =>
    obj.getShapes().filter((s: any): s is Edge => s instanceof Edge);

  describe("primitive role stamping", () => {
    it("stamps solved lines as body and circle perimeters", () => {
      let c: ReturnType<typeof circle>;
      let l: ReturnType<typeof line>;
      sketch("xy", () => {
        c = circle([0, 0], 40);
        l = line([60, 0], [90, 0]);
      });
      render();

      expect(edgesOf(c! as any)[0].role).toBe('perimeter');
      expect(edgesOf(l! as any)[0].role).toBe('body');
    });
  });

  describe("serialization to the rendered scene", () => {
    it("carries role/provenance and interactivity to RenderedShape", () => {
      let r: ReturnType<typeof testRect>;
      let o: Offset;
      const s = sketch("xy", () => {
        r = testRect(80, 60);
        o = offset(5) as Offset;
      }) as Sketch;

      const scene = render();

      const renderedLine = scene.getRenderedObject(r!.b as any)!;
      expect(renderedLine.sceneShapes.map(sh => sh.role)).toEqual(['body']);
      expect(renderedLine.interactivity).toBe('draggable');

      const renderedOffset = scene.getRenderedObject(o!)!;
      expect(renderedOffset.interactivity).toBe('selectable');
      const provenance = renderedOffset.sceneShapes.map(sh => sh.provenance);
      provenance.forEach(p => expect(p).toBe('offset-of'));

      expect(scene.getRenderedObject(s)!.interactivity).toBeUndefined();
    });
  });

  describe("accessor as fillet target", () => {
    it("fillets the corner between two selected profile lines", () => {
      let r: ReturnType<typeof testRect>;
      let f: Fillet2D;
      const s = sketch("xy", () => {
        r = testRect(80, 60);
        f = fillet(4, r.t as any, r.l as any) as Fillet2D;
      }) as Sketch;

      render();

      // The fillet owns trimmed top + corner arc + trimmed left.
      const filletEdges = edgesOf(f!);
      expect(filletEdges).toHaveLength(3);

      const arcs = filletEdges.filter(edge => EdgeQuery.getEdgeCurveType(edge) === 'circle');
      expect(arcs).toHaveLength(1);
      expect(arcs[0].provenance).toBe('fillet-arc');

      // Trimmed survivors keep their construction roles.
      const survivorRoles = filletEdges
        .filter(edge => EdgeQuery.getEdgeCurveType(edge) === 'line')
        .map(edge => edge.role);
      expect(survivorRoles).toEqual(['body', 'body']);

      // The replaced originals no longer render on their producers.
      expect(edgesOf(r!.t as any)).toHaveLength(0);
      expect(edgesOf(r!.l as any)).toHaveLength(0);

      // No double counting: 2 surviving rect lines + 3 fillet edges.
      const edgeMap = s.getEdgesWithOwner();
      expect(edgeMap.size).toBe(5);
      for (const owner of edgeMap.values()) {
        expect(owner.isLazy()).toBe(false);
      }
    });

    it("extrudes a filleted profile into the exact solid", () => {
      sketch("xy", () => {
        const r = testRect(80, 60);
        fillet(4, r.t as any, r.l as any);
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
  });

  describe("whole-sketch fillet chain", () => {
    it("keeps body roles on trimmed edges and stamps fillet-arc on corners", () => {
      let f: Fillet2D;
      sketch("xy", () => {
        testRect(80, 60);
        f = fillet(6) as Fillet2D;
      });
      render();

      const edges = edgesOf(f!);
      expect(edges).toHaveLength(8);

      const arcs = edges.filter(edge => edge.provenance === 'fillet-arc');
      expect(arcs).toHaveLength(4);

      const sideRoles = edges.filter(edge => edge.provenance !== 'fillet-arc').map(edge => edge.role);
      expect(sideRoles).toEqual(['body', 'body', 'body', 'body']);
    });
  });

  describe("roles survive transforms", () => {
    it("mirror2d copies keep roles and gain mirror-copy provenance", () => {
      let m: MirrorShape2D;
      sketch("xy", () => {
        testRect(40, 30, { at: [10, 0] });
        m = mirror("y") as MirrorShape2D;
      });
      render();

      const copies = edgesOf(m!);
      expect(copies).toHaveLength(4);
      copies.forEach(e => expect(e.role).toBe('body'));
      copies.forEach(e => expect(e.provenance).toBe('mirror-copy'));
    });

    it("cloned sketches (repeat) keep roles on transformed edges", () => {
      const s = sketch("xy", () => {
        testRect(40, 30);
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
        expect(roles).toEqual(['body', 'body', 'body', 'body']);
      }
    });
  });
});
