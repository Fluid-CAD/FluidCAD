import type { TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { OcIO } from "./io.js";
import { composePose, IDENTITY_POSE } from "../math/pose.js";
import type { Pose } from "../math/pose.js";
import type { AssemblyExportNode, AssemblyExportPart } from "../io/assembly-export/tree.js";

/**
 * Every solid of an assembly tree moved to where its instance sits, as one
 * compound — the flattened view mesh writers (STL) need. `Moved` shares the
 * geometry and only attaches a location, so repeated instances cost no
 * copies. Dispose the result when done with the compound: it owns the
 * moved wrappers and their locations.
 */
export class OcAssemblyPlacement {
  static placedCompound(
    nodes: AssemblyExportNode[],
    parts: Map<string, AssemblyExportPart>,
  ): { compound: TopoDS_Shape; dispose: () => void } {
    const oc = getOC();
    const placed: TopoDS_Shape[] = [];
    const disposers: (() => void)[] = [];

    const visit = (list: AssemblyExportNode[], parentWorld: Pose): void => {
      for (const node of list) {
        const world = composePose(parentWorld, node.pose);
        if (node.kind === 'occurrence') {
          visit(node.children, world);
          continue;
        }
        const part = parts.get(node.partId);
        if (!part || part.solids.length === 0) {
          continue;
        }
        const [trsf, disposeTrsf] = Convert.toGpTrsfPose(world.position, world.quaternion);
        const location = new oc.TopLoc_Location(trsf);
        for (const solid of part.solids) {
          const moved = solid.getShape().Moved(location, false);
          placed.push(moved);
          disposers.push(() => moved.delete());
        }
        disposers.push(() => {
          location.delete();
          disposeTrsf();
        });
      }
    };
    visit(nodes, IDENTITY_POSE);

    const compound = OcIO.makeCompoundRaw(placed);
    return {
      compound,
      dispose: () => {
        compound.delete();
        for (const dispose of disposers.reverse()) {
          dispose();
        }
      },
    };
  }
}
