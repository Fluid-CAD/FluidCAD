import { captureSourceLocation } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { Part } from "../features/part.js";
import { ISceneObject } from "./interfaces.js";

type Extend<T> = T extends object ? { features: T } : {};

function part<T>(name: string, callback: () => T): ISceneObject & Extend<T> {
  const scene = getCurrentScene();
  if (!scene) {
    throw new Error("part() must be called within a scene context");
  }

  const sourceLocation = captureSourceLocation();
  const partObj = new Part(name);
  if (sourceLocation) {
    partObj.setSourceLocation(sourceLocation);
  }
  scene.startProgressiveContainer(partObj);
  const extensions = callback();
  scene.endProgressiveContainer();

  if (extensions && typeof extensions === 'object') {
    (partObj as any).features = extensions;
  }

  return partObj as unknown as ISceneObject & Extend<T>;
}

export default part;
