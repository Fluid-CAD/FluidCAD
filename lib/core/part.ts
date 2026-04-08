import { captureSourceLocation } from "../index.js";
import { getCurrentScene, getCurrentFile } from "../scene-manager.js";
import { Part } from "../features/part.js";

export type PartHandle = {
  __fluidcad_part: true;
  name: string;
  _callback: () => void;
};

function part(name: string, callback: () => void): PartHandle {
  const handle: PartHandle = {
    __fluidcad_part: true,
    name,
    _callback: callback,
  };

  const sourceLocation = captureSourceLocation();
  const currentFile = getCurrentFile();

  const isDirectEdit = sourceLocation
    && currentFile
    && sourceLocation.filePath.replace('virtual:live-render:', '') === currentFile;

  if (isDirectEdit) {
    const scene = getCurrentScene();
    if (scene) {
      const partObj = new Part(name);
      if (sourceLocation) {
        partObj.setSourceLocation(sourceLocation);
      }
      scene.startProgressiveContainer(partObj);
      callback();
      scene.endProgressiveContainer();
    }
  }

  return handle;
}

export default part;
