import { Scene } from "./scene.js";
import { Shape } from "../common/shape.js";
import { SceneObject } from "../common/scene-object.js";
import { Connector } from "../features/connector.js";

/**
 * Stamp every rendered connector with the ids of the body it sits on —
 * `object.hostShapeIds` on its render payload — so the viewer can hide the
 * connector together with that body (the shapes panel's eye toggle).
 *
 * The connector recorded its host as built (Connector.getHostShape). A later
 * feature may have replaced that body — a fillet or cut after the connector
 * statement removes the extrude's solid and adds its own — so the as-built
 * host is walked forward through the removal records to the shapes actually
 * emitted in this pass: the ids the viewer keys visibility on. A fuse may
 * merge the host into a bigger body (one id), a split may leave several
 * (all listed). A host that resolves to nothing on screen — or a plane- or
 * point-sourced connector — gets no field, and the connector follows the
 * global toggle alone.
 *
 * Runs after emission, for both the full render and a rollback: `scope` is
 * the pass's scope, and only removals by an in-scope remover are followed,
 * matching how getOwnShapes decides what the pass shows.
 */
export function attachConnectorHosts(scene: Scene, scope: Set<SceneObject>): void {
  const objects = scene.getAllSceneObjects();
  const connectors = objects.filter((obj): obj is Connector => obj instanceof Connector);
  if (connectors.length === 0) {
    return;
  }

  const present = new Set<string>();
  for (const rendered of scene.getRenderedObjects()) {
    for (const shape of rendered.sceneShapes) {
      if (!shape.isMetaShape) {
        present.add(shape.shapeId);
      }
    }
  }

  const ownerOf = new Map<Shape, SceneObject>();
  for (const obj of objects) {
    for (const shape of obj.getAddedShapes()) {
      ownerOf.set(shape, obj);
    }
  }

  const resolveLive = (shape: Shape, seen: Set<Shape>): string[] => {
    if (seen.has(shape)) {
      return [];
    }
    seen.add(shape);
    if (present.has(shape.id)) {
      return [shape.id];
    }
    const owner = ownerOf.get(shape);
    const removal = owner?.getRemovedShapes().find(r => r.shape === shape && !r.soft && scope.has(r.removedBy));
    if (!removal) {
      return [];
    }
    const ids: string[] = [];
    for (const successor of removal.removedBy.getAddedShapes()) {
      if (!successor.isMetaShape() && !successor.isGuideShape()) {
        ids.push(...resolveLive(successor, seen));
      }
    }
    return ids;
  };

  for (const connector of connectors) {
    const rendered = scene.getRenderedObject(connector);
    const host = connector.getHostShape();
    if (!rendered || !host) {
      continue;
    }
    const ids = Array.from(new Set(resolveLive(host, new Set())));
    if (ids.length > 0) {
      rendered.object.hostShapeIds = ids;
    }
  }
}
