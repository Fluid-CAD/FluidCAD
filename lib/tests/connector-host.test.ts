import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import { getSceneManager } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import fillet from "../core/fillet.js";
import select from "../core/select.js";
import part from "../core/part.js";
import plane from "../core/plane.js";
import connector from "../core/connector.js";
import { testRect } from "./helpers/profiles.js";
import { face } from "../filters/index.js";
import { Extrude } from "../features/extrude.js";
import { Scene, SceneObjectRender } from "../rendering/scene.js";

/** The rendered connector's payload plus the id of the one rendered solid. */
function renderedConnector(scene: Scene): { connector: SceneObjectRender; solidIds: string[] } {
  const rendered = scene.getRenderedObjects();
  const conn = rendered.find(o => o.type === "connector");
  expect(conn, "a rendered connector").toBeDefined();
  const solidIds = rendered
    .flatMap(o => o.sceneShapes)
    .filter(s => s.shapeType === "solid" && !s.isMetaShape)
    .map(s => s.shapeId);
  return { connector: conn!, solidIds };
}

describe("connector host body", () => {
  setupOC();

  it("names the rendered solid the source face belongs to", () => {
    part("block", () => {
      sketch("xy", () => { testRect(20, 20); });
      extrude(10);
      connector("top", select(face().planar().onPlane("xy", 10)));
    });
    const scene = render();
    const { connector: conn, solidIds } = renderedConnector(scene);
    expect(solidIds).toHaveLength(1);
    expect(conn.object.hostShapeIds).toEqual(solidIds);
  });

  it("follows the body through a feature that replaces it after the connector", () => {
    // The fillet consumes the extrude's solid and emits its own — the id the
    // shapes panel shows is the fillet's, so that is what the connector must
    // name, not the as-built extrude solid.
    let e!: Extrude;
    part("block", () => {
      sketch("xy", () => { testRect(20, 20); });
      e = extrude(10) as Extrude;
      connector("top", e.endFaces().center());
      fillet(2, e.endEdges());
    });
    const scene = render();
    const { connector: conn, solidIds } = renderedConnector(scene);
    expect(solidIds).toHaveLength(1);
    const extrudeRender = scene.getRenderedObject(e)!;
    expect(extrudeRender.sceneShapes.filter(s => s.shapeType === "solid")).toHaveLength(0);
    expect(conn.object.hostShapeIds).toEqual(solidIds);
  });

  it("re-resolves to the as-built body on a rollback before the replacement", () => {
    let e!: Extrude;
    part("block", () => {
      sketch("xy", () => { testRect(20, 20); });
      e = extrude(10) as Extrude;
      connector("top", e.endFaces().center());
      fillet(2, e.endEdges());
    });
    const scene = render();
    const objects = scene.getAllSceneObjects();
    const connectorIndex = objects.findIndex(o => o.getType() === "connector");
    getSceneManager().rollbackScene(scene, connectorIndex);

    const { connector: conn, solidIds } = renderedConnector(scene);
    expect(solidIds).toHaveLength(1);
    expect(scene.getRenderedObject(e)!.sceneShapes.map(s => s.shapeId)).toEqual(solidIds);
    expect(conn.object.hostShapeIds).toEqual(solidIds);
  });

  it("leaves a plane-sourced connector without a host", () => {
    part("block", () => {
      sketch("xy", () => { testRect(20, 20); });
      extrude(10);
      connector("side", plane("xz"));
    });
    const scene = render();
    const { connector: conn } = renderedConnector(scene);
    expect(conn.object.hostShapeIds).toBeUndefined();
  });
});
