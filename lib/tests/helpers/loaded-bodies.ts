import { beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import { join } from "path";
import { OcIO } from "../../oc/io.js";
import { setAssetProvider } from "../../io/file-import.js";
import load from "../../core/load.js";
import type { LoadFile } from "../../features/load.js";
import type { Shape } from "../../common/shape.js";

let workspace: string | null = null;
let serial = 0;

/**
 * Lets a test file put kernel-built surfaces, curves and solids in a scene
 * the way a user does: through `load()` of an imported asset. Registers a
 * throw-away workspace whose `imports/` folder {@link loadShapes} writes to.
 */
export function useLoadedBodies(): void {
  beforeAll(() => {
    workspace = fs.mkdtempSync(join(os.tmpdir(), "fluidcad-loaded-bodies-"));
    fs.mkdirSync(join(workspace, "imports"));
    const root = workspace;
    setAssetProvider(rel => {
      const file = join(root, rel);
      return fs.existsSync(file) ? fs.readFileSync(file) : null;
    });
  });

  afterAll(() => {
    setAssetProvider(null);
    if (workspace) {
      fs.rmSync(workspace, { recursive: true, force: true });
      workspace = null;
    }
  });
}

/**
 * A `load()` statement holding `shapes`, in order, written to the asset
 * cache an import would have written. The shapes are the test's own kernel
 * builds and are freed here: the statement holds copies read back from the
 * cache.
 */
export function loadShapes(shapes: Shape[]): LoadFile {
  if (!workspace) {
    throw new Error("loadShapes: call useLoadedBodies() in the test file first");
  }
  const name = `bodies-${++serial}`;
  try {
    fs.writeFileSync(join(workspace, "imports", `${name}.brep`), OcIO.writeBodiesAsBRep(shapes, `${name}.brep`));
    fs.writeFileSync(join(workspace, "imports", `${name}.colors.json`), JSON.stringify(shapes.map(() => ({ faces: [] }))));
  } finally {
    shapes.forEach(shape => shape.dispose());
  }
  return load(name) as unknown as LoadFile;
}
