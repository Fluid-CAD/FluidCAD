import { describe, expect, it } from "vitest";
import { setupOC, render } from "../setup.js";
import {
  sketch, line, loft, plane, extrude, revolve, circle, ellipse, spline, fillet, chamfer, select, sphere, cylinder,
} from "../../core/index.js";
import { face, edge } from "../../filters/index.js";
import { SceneObject } from "../../common/scene-object.js";
import { Solid } from "../../common/solid.js";
import { Face } from "../../common/face.js";
import { Edge } from "../../common/edge.js";
import { FaceQuery } from "../../oc/face-query.js";
import { EdgeQuery } from "../../oc/edge-query.js";
import { FaceProps } from "../../oc/face-props.js";
import { EdgeProps } from "../../oc/edge-props.js";
import { classifyEdge, classifyFace } from "../../oc/measure/classify.js";
import { SurfaceClassifier } from "../../oc/surface-classifier.js";
import { CurveClassifier } from "../../oc/curve-classifier.js";
import { SelectSceneObject } from "../../features/select.js";

/**
 * The filters, the properties and measure read a face's or an edge's kind
 * from one classifier each, so on every face and edge of a body they agree.
 * The properties name every kind the classifiers do; measure and the filter
 * checks below each speak their own vocabulary, and the kinds one has no
 * word for (a sphere for these face checks, an ellipse for these edge
 * checks, a spline or a free-form face for measure) are its "other".
 */
describe("classifier agreement", () => {
  setupOC();

  function roundedRect(z: number) {
    return sketch(plane("xy", z), () => {
      const b = line([-11, -8], [11, -8]);
      const r = line([11, -8], [11, 8]);
      const t = line([11, 8], [-11, 8]);
      const l = line([-11, 8], [-11, -8]);
      fillet(4, b, r, t, l);
    });
  }


  /** Bodies, apart from one another, with every kind of face and edge the classifiers name. */
  function buildBodies(): void {
    loft(roundedRect(0), roundedRect(20));
    const round = sketch(plane("xy", 100), () => {
      circle([0, 0], 20);
    });
    const oval = sketch(plane("xy", 130), () => {
      ellipse([0, 0], 5, 9);
    });
    loft(round, oval);
    sketch("xz", () => {
      line([0, 300], [10, 300]);
      spline([10, 300], [14, 305], [9, 310], [13, 315]);
      line([13, 315], [0, 315]);
      line([0, 315], [0, 300]);
    });
    revolve("z");
    sketch(plane("xy", -100), () => {
      line([0, 0], [10, 0]);
      spline([10, 0], [14, 5], [9, 10], [13, 15]);
      line([13, 15], [0, 15]);
      line([0, 15], [0, 0]);
    });
    extrude(10);
    sphere(8).translate(200, 0, 0);
    const pin = cylinder(6, 20).translate(0, 200, 0);
    fillet(2, select(edge().circle().from(pin)));
    const peg = cylinder(6, 20).translate(0, -200, 0);
    chamfer(2, select(edge().circle().from(peg)));
  }

  function facesAndEdges(): { faces: Face[]; edges: Edge[] } {
    const faces: Face[] = [];
    const edges: Edge[] = [];
    for (const shape of render().getAllSceneObjects().flatMap(o => o.getShapes())) {
      if (shape instanceof Solid) {
        faces.push(...shape.getFaces());
        edges.push(...shape.getEdges());
      }
    }
    return { faces, edges };
  }

  function faceFilterKind(f: Face): string {
    if (FaceQuery.isPlanarFace(f)) {
      return "plane";
    }
    if (FaceQuery.isCylinderFace(f) || FaceQuery.isCylinderCurveFace(f)) {
      return "cylinder";
    }
    if (FaceQuery.isConeFace(f)) {
      return "cone";
    }
    if (FaceQuery.isTorusFace(f)) {
      return "torus";
    }
    return "other";
  }

  function edgeFilterKind(e: Edge): string {
    if (EdgeQuery.isLineEdge(e)) {
      return "line";
    }
    if (EdgeQuery.isArcEdge(e)) {
      return "arc";
    }
    if (EdgeQuery.isCircleEdge(e)) {
      return "circle";
    }
    return "other";
  }

  it("agree on every face", () => {
    buildBodies();
    const { faces } = facesAndEdges();
    const seen = new Set<string>();
    for (const f of faces) {
      const surface = SurfaceClassifier.classify(f);
      seen.add(surface.kind);
      const kind = SurfaceClassifier.isAnalytic(surface.kind) ? surface.kind : "other";

      const props = FaceProps.getProperties(f.getShape());
      expect(props.surfaceType === "circle" ? "plane" : props.surfaceType).toBe(surface.kind);
      expect(props.recovered).toBe(surface.recovered);

      const measured = classifyFace(f.getShape()).form;
      expect(measured === "surface" ? "other" : measured).toBe(kind);

      expect(faceFilterKind(f)).toBe(kind === "sphere" ? "other" : kind);
      expect(FaceQuery.getSurfaceType(f)).toBe(kind);

      if (kind === "cylinder") {
        expect(props.closed).toBe(FaceQuery.isCylinderFace(f));
      }
      expect(props.surfaceType === "circle").toBe(FaceQuery.isCircleFace(f));
    }
    expect([...seen].sort()).toEqual(["cone", "cylinder", "extruded", "freeform", "plane", "revolved", "sphere", "torus"]);
  });

  it("agree on every edge", () => {
    buildBodies();
    const { edges } = facesAndEdges();
    const seen = new Set<string>();
    for (const e of edges) {
      const curve = CurveClassifier.classify(e);
      seen.add(curve.kind);
      const kind = curve.kind === "spline" ? "other" : curve.kind;

      const props = EdgeProps.getProperties(e.getShape());
      expect(props.curveType).toBe(curve.kind);
      expect(props.closed).toBe(curve.closed);
      expect(props.planar).toBe(curve.planar);

      const measured = classifyEdge(e.getShape()).form;
      expect(measured === "curve" ? "other" : measured).toBe(kind);

      expect(edgeFilterKind(e)).toBe(kind === "ellipse" ? "other" : kind);
    }
    expect([...seen].sort()).toEqual(["arc", "circle", "ellipse", "line", "spline"]);
  });

  describe("properties of a wrapper", () => {
    it("are those of its raw shape, on every face and edge", () => {
      buildBodies();
      const { faces, edges } = facesAndEdges();
      for (const f of faces) {
        expect({ ...FaceProps.of(f) }).toEqual(FaceProps.getProperties(f.getShape()));
        expect(FaceQuery.hasClosedCircularRim(f)).toBe(FaceQuery.hasClosedCircularRimRaw(f.getShape()));
      }
      for (const e of edges) {
        expect({ ...EdgeProps.of(e) }).toEqual(EdgeProps.getProperties(e.getShape()));
      }
    });

    it("leave a spline's plane unfitted and a free-form face's area unintegrated until they are read", () => {
      buildBodies();
      const { faces, edges } = facesAndEdges();
      const wall = faces.find(f => SurfaceClassifier.classify(f).kind === "freeform")!;
      const wallProps = FaceProps.of(wall);
      const area = () => Object.getOwnPropertyDescriptor(SurfaceClassifier.classify(wall), "areaMm2")?.get;
      expect(wallProps.surfaceType).toBe("freeform");
      expect(area()).toBeDefined();
      expect(wallProps.areaMm2).toBeGreaterThan(0);
      expect(area()).toBeUndefined();

      const curve = edges.find(e => CurveClassifier.classify(e).kind === "spline")!;
      const curveProps = EdgeProps.of(curve);
      const fit = () => Object.getOwnPropertyDescriptor(CurveClassifier.classify(curve), "planar")?.get;
      expect(curveProps.curveType).toBe("spline");
      expect(fit()).toBeDefined();
      expect(typeof curveProps.planar).toBe("boolean");
      expect(fit()).toBeUndefined();
    });
  });

  describe("faces stored as B-splines", () => {
    function roundedLoft() {
      return loft(roundedRect(0), roundedRect(20));
    }

    it("face().planar() matches the flat walls of a loft", () => {
      roundedLoft();
      const planar = select(face().planar()) as SelectSceneObject;
      const notPlanar = select(face().notPlanar()) as SelectSceneObject;
      const sides = select(face().planar().parallelTo("xz")) as SelectSceneObject;
      render();
      // Four flat walls and the two native caps.
      expect(planar.getShapes()).toHaveLength(6);
      expect(notPlanar.getShapes()).toHaveLength(4);
      expect(sides.getShapes()).toHaveLength(2);
    });

    it("face().cylinderCurve(d) matches the round corners of a loft", () => {
      roundedLoft();
      const corners = select(face().cylinderCurve(8)) as SelectSceneObject;
      const wrongSize = select(face().cylinderCurve(9)) as SelectSceneObject;
      const full = select(face().cylinder()) as SelectSceneObject;
      render();
      expect(corners.getShapes()).toHaveLength(4);
      expect(wrongSize.getShapes()).toHaveLength(0);
      expect(full.getShapes()).toHaveLength(0);
    });

    it("compares recovered surfaces like native ones", () => {
      const lofted = roundedLoft() as unknown as SceneObject;
      render();
      const faces = (lofted.getShapes()[0] as Solid).getFaces();
      const walls = faces.filter(f => SurfaceClassifier.classify(f).recovered);
      for (const wall of walls) {
        expect(FaceQuery.isSameSurface(wall, wall)).toBe(true);
      }
      const corners = walls.filter(f => SurfaceClassifier.classify(f).kind === "cylinder");
      expect(corners).toHaveLength(4);
      expect(FaceQuery.isSameSurface(corners[0], corners[1])).toBe(false);
      const flats = walls.filter(f => SurfaceClassifier.classify(f).kind === "plane");
      expect(flats.filter(f => f !== flats[0] && FaceQuery.isSameSurface(flats[0], f))).toHaveLength(0);
    });
  });
});
