import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import fillet from "../../core/fillet.js";
import select from "../../core/select.js";
import { rect } from "../../core/2d/index.js";
import { Face } from "../../common/face.js";
import { Edge } from "../../common/edge.js";
import { face, edge } from "../../filters/index.js";
import { SelectSceneObject } from "../../features/select.js";

function box() {
  sketch("xy", () => {
    rect(100, 50);
  });
  extrude(30);
}

describe("positional filter selectors (.first / .last / .at)", () => {
  setupOC();

  it("singleton match: first/last/at(0) all return the same face", () => {
    box();

    const first = select(face().onPlane("xy", 30).first()) as SelectSceneObject;
    const last = select(face().onPlane("xy", 30).last()) as SelectSceneObject;
    const at0 = select(face().onPlane("xy", 30).at(0)) as SelectSceneObject;
    const at1 = select(face().onPlane("xy", 30).at(1)) as SelectSceneObject;

    render();

    const firstFaces = first.getShapes() as Face[];
    const lastFaces = last.getShapes() as Face[];
    const at0Faces = at0.getShapes() as Face[];
    const at1Faces = at1.getShapes() as Face[];

    expect(firstFaces).toHaveLength(1);
    expect(lastFaces).toHaveLength(1);
    expect(at0Faces).toHaveLength(1);
    expect(at1Faces).toHaveLength(0);
  });

  it("multiple matches: first, last and at(i) pick distinct positions", () => {
    box();

    const all = select(face().notOnPlane("xy", 30).notOnPlane("xy")) as SelectSceneObject;
    const first = select(face().notOnPlane("xy", 30).notOnPlane("xy").first()) as SelectSceneObject;
    const last = select(face().notOnPlane("xy", 30).notOnPlane("xy").last()) as SelectSceneObject;
    const at0 = select(face().notOnPlane("xy", 30).notOnPlane("xy").at(0)) as SelectSceneObject;
    const at2 = select(face().notOnPlane("xy", 30).notOnPlane("xy").at(2)) as SelectSceneObject;
    const at4 = select(face().notOnPlane("xy", 30).notOnPlane("xy").at(4)) as SelectSceneObject;

    render();

    const allFaces = all.getShapes() as Face[];
    expect(allFaces).toHaveLength(4);

    const firstFace = (first.getShapes() as Face[])[0];
    const lastFace = (last.getShapes() as Face[])[0];
    const at0Face = (at0.getShapes() as Face[])[0];
    const at2Face = (at2.getShapes() as Face[])[0];

    expect(first.getShapes()).toHaveLength(1);
    expect(last.getShapes()).toHaveLength(1);
    expect(at0.getShapes()).toHaveLength(1);
    expect(at2.getShapes()).toHaveLength(1);
    expect(at4.getShapes()).toHaveLength(0);

    expect(at0Face).toBe(firstFace);
    expect(at2Face).not.toBe(at0Face);
    expect(lastFace).not.toBe(firstFace);
  });

  it("edge selectors: at(i), first, last match expected positions", () => {
    box();

    const all = select(edge().onPlane("xy")) as SelectSceneObject;
    const at0 = select(edge().onPlane("xy").at(0)) as SelectSceneObject;
    const at3 = select(edge().onPlane("xy").at(3)) as SelectSceneObject;
    const at4 = select(edge().onPlane("xy").at(4)) as SelectSceneObject;
    const first = select(edge().onPlane("xy").first()) as SelectSceneObject;
    const last = select(edge().onPlane("xy").last()) as SelectSceneObject;

    render();

    expect((all.getShapes() as Edge[])).toHaveLength(4);
    expect((at0.getShapes() as Edge[])).toHaveLength(1);
    expect((at3.getShapes() as Edge[])).toHaveLength(1);
    expect((at4.getShapes() as Edge[])).toHaveLength(0);

    const at0Edge = (at0.getShapes() as Edge[])[0];
    const at3Edge = (at3.getShapes() as Edge[])[0];
    const firstEdge = (first.getShapes() as Edge[])[0];
    const lastEdge = (last.getShapes() as Edge[])[0];

    expect(firstEdge).toBe(at0Edge);
    expect(lastEdge).toBe(at3Edge);
  });

  it("two builders in one select: each evaluates its own selector", () => {
    box();

    const sel = select(
      face().onPlane("xy").first(),
      face().onPlane("xy", 30).first(),
    ) as SelectSceneObject;

    render();

    expect((sel.getShapes() as Face[])).toHaveLength(2);
  });

  it("withTangents() composes after selection", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    extrude(30);

    select(edge().verticalTo("xy"));
    fillet(5);

    const sel = select(face().planar().first().withTangents()) as SelectSceneObject;
    render();

    expect((sel.getShapes() as Face[]).length).toBeGreaterThanOrEqual(1);
  });

  it("last call wins when multiple selectors are chained", () => {
    box();

    const firstThenLast = select(face().notOnPlane("xy", 30).notOnPlane("xy").first().last()) as SelectSceneObject;
    const lastOnly = select(face().notOnPlane("xy", 30).notOnPlane("xy").last()) as SelectSceneObject;

    render();

    const a = (firstThenLast.getShapes() as Face[])[0];
    const b = (lastOnly.getShapes() as Face[])[0];
    expect(firstThenLast.getShapes()).toHaveLength(1);
    expect(a).toBe(b);
  });

  it("at(-1) throws", () => {
    expect(() => face().at(-1)).toThrow();
    expect(() => edge().at(-1)).toThrow();
    expect(() => face().at(1.5)).toThrow();
  });

  it("equals() distinguishes builders by selector", () => {
    const a = face().onPlane("xy").first();
    const b = face().onPlane("xy").last();
    const c = face().onPlane("xy").first();
    const d = face().onPlane("xy").at(0);
    const e = face().onPlane("xy").at(1);
    const noSel = face().onPlane("xy");

    expect(a.equals(c)).toBe(true);
    expect(a.equals(b)).toBe(false);
    expect(a.equals(noSel)).toBe(false);
    expect(d.equals(e)).toBe(false);
    expect(d.equals(face().onPlane("xy").at(0))).toBe(true);
  });

  it("getIndexSelector returns the configured selector", () => {
    expect(face().getIndexSelector()).toBeUndefined();
    expect(face().first().getIndexSelector()).toEqual({ type: "first" });
    expect(face().last().getIndexSelector()).toEqual({ type: "last" });
    expect(face().at(2).getIndexSelector()).toEqual({ type: "at", index: 2 });
    expect(face().first().last().getIndexSelector()).toEqual({ type: "last" });
  });
});
