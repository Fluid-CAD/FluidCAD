import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import fillet from "../../core/fillet.js";
import select from "../../core/select.js";
import { rect } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { Face } from "../../common/face.js";
import { face, edge } from "../../filters/index.js";
import cylinder from "../../core/cylinder.js";
import { getFacesByType } from "../utils.js";
import { FaceQuery } from "../../oc/face-query.js";
import { SelectSceneObject } from "../../features/select.js";
import { Explorer } from "../../oc/explorer.js";
import { getOC } from "../../oc/init.js";

function getSolid(): Solid {
  return render().getAllSceneObjects()
    .flatMap(o => o.getShapes())
    .find(s => s.getType() === "solid") as Solid;
}

describe("cylinderCurve filter on fillet faces", () => {
  setupOC();

  it("recognizes fillet faces produced from straight vertical edges (no draft)", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    extrude(30);

    select(edge().verticalTo("xy"));
    fillet(5);

    const solid = getSolid();
    const cylFaces = getFacesByType(solid, "cylinder");
    expect(cylFaces).toHaveLength(4);

    const cylinderCurveFaces = cylFaces.filter(f => FaceQuery.isCylinderCurveFace(f));
    expect(cylinderCurveFaces).toHaveLength(4);
  });

  it("recognizes fillet faces produced from drafted vertical edges (matches user repro)", () => {
    sketch("xy", () => {
      rect(205, 133).centered();
    });
    const body = extrude(100).draft(10);

    fillet(32, body.sideEdges());

    const solid = getSolid();
    const cylFaces = getFacesByType(solid, "cylinder");
    expect(cylFaces.length).toBeGreaterThan(0);

    const cylinderCurveFaces = cylFaces.filter(f => FaceQuery.isCylinderCurveFace(f));

    if (cylinderCurveFaces.length !== cylFaces.length) {
      const oc = getOC();
      const missed = cylFaces.filter(f => !FaceQuery.isCylinderCurveFace(f));
      for (const face of missed) {
        const ocFace = oc.TopoDS.Face(face.getShape());
        const edges = Explorer.findShapes(ocFace, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
        const curveTypeNames: Record<number, string> = {};
        for (const k of Object.keys(oc.GeomAbs_CurveType)) {
          const v = (oc.GeomAbs_CurveType as Record<string, { value: number }>)[k];
          if (v && typeof v.value === "number") {
            curveTypeNames[v.value] = k;
          }
        }
        const edgeInfo = edges.map(e => {
          const adaptor = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e));
          const t = adaptor.GetType();
          const closed = adaptor.IsClosed();
          adaptor.delete();
          return { type: curveTypeNames[(t as { value: number }).value] ?? (t as { value: number }).value, closed };
        });
        console.log("Cylinder face missed by cylinderCurve:", JSON.stringify(edgeInfo));
      }
    }

    expect(cylinderCurveFaces).toHaveLength(cylFaces.length);
  });

  it("face().cylinderCurve() returns fillet faces (drafted body)", () => {
    sketch("xy", () => {
      rect(205, 133).centered();
    });
    const body = extrude(100).draft(10);

    fillet(32, body.sideEdges());

    const sel = select(face().cylinderCurve()) as SelectSceneObject;

    render();

    const selectedFaces = sel.getShapes() as Face[];
    expect(selectedFaces.length).toBeGreaterThan(0);
  });

  it("cylinderCurve(diameter) matches the cylinder surface radius, not bounding-edge radius", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    extrude(30);

    select(edge().verticalTo("xy"));
    fillet(5);

    const matchingSel = select(face().cylinderCurve(10)) as SelectSceneObject;
    const nonMatchingSel = select(face().cylinderCurve(20)) as SelectSceneObject;

    render();

    expect((matchingSel.getShapes() as Face[])).toHaveLength(4);
    expect((nonMatchingSel.getShapes() as Face[])).toHaveLength(0);
  });

  it("cylinderCurve does NOT match a full cylinder primitive", () => {
    cylinder(20, 30);

    const sel = select(face().cylinderCurve()) as SelectSceneObject;
    render();

    expect((sel.getShapes() as Face[])).toHaveLength(0);
  });
});
