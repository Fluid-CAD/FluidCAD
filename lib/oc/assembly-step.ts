import type { TDF_Label, TopoDS_Shape, XCAFDoc_ColorTool, XCAFDoc_ColorType, XCAFDoc_ShapeTool } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Convert } from "./convert.js";
import { OcIO } from "./io.js";
import { StepConform } from "./step-conform.js";
import { MM_PER_UNIT } from "../units/units.js";
import type { Pose } from "../math/pose.js";
import { nodeHasSolids } from "../io/assembly-export/tree.js";
import type { AssemblyExportNode, AssemblyExportPart, AssemblyExportTree } from "../io/assembly-export/tree.js";

/**
 * Structured STEP (AP214 via XCAF) of an assembly tree: the root product
 * holds one component per instance, each referencing a prototype label
 * that is shared by every instance of the same part, and sub-assembly
 * occurrences nest as assembly labels of their own. Poses ride as
 * `TopLoc_Location`s on the component references — the geometry itself is
 * written once per part, in the part's own frame.
 *
 * This is exactly how OCCT's own STEP reader populates a document
 * (`NewShape` + `AddComponent`), so every consumer that reads OCCT-written
 * assemblies reads this. `NewShape()` seeds the label with an empty
 * compound, which `AddComponent` turns into an assembly on first use.
 */
export class OcAssemblyStep {
  static writeStepAssembly(tree: AssemblyExportTree, fileName: string, includeColors: boolean): string {
    const oc = getOC();

    const app = new oc.TDocStd_Application();
    const format = new oc.TCollection_ExtendedString('MDTV-XCAF');
    const docHandle = new oc.TDocStd_Document(format);
    app.InitDocument(docHandle);
    format.delete();

    const shapeTool = oc.XCAFDoc_DocumentTool.ShapeTool(docHandle.Main());
    const colorTool = oc.XCAFDoc_DocumentTool.ColorTool(docHandle.Main());
    const surfType = oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf;
    const disposers: (() => void)[] = [];

    const cleanup = () => {
      for (const dispose of disposers.reverse()) {
        dispose();
      }
      shapeTool.delete();
      colorTool.delete();
      // No app.Close(): an InitDocument'd doc cannot be closed in OCCT V8 —
      // deleting the handle releases it.
      docHandle.delete();
      app.delete();
    };

    try {
      // Prototypes first: one label per part that some instance uses.
      const prototypes = new Map<string, TDF_Label>();
      for (const part of tree.parts.values()) {
        if (part.solids.length === 0) {
          continue;
        }
        const label = OcAssemblyStep.addPrototype(part, shapeTool, colorTool, surfType, includeColors, disposers);
        prototypes.set(part.partId, label);
      }

      const root = shapeTool.NewShape();
      OcAssemblyStep.nameLabel(root, tree.name);
      OcAssemblyStep.addComponents(root, tree.children, tree.parts, prototypes, shapeTool, disposers);

      shapeTool.UpdateAssemblies();
      // The 2-arg overload takes the document's internal unit in metres.
      oc.XCAFDoc_DocumentTool.SetLengthUnit(docHandle, MM_PER_UNIT[tree.unit] / 1000);

      const writer = new oc.STEPCAFControl_Writer();
      writer.SetColorMode(includeColors);
      writer.SetNameMode(true);
      const progress = new oc.Message_ProgressRange();
      // Perform() is Transfer(doc, AsIs, multi = NULL) + Write(); any
      // non-null `multi` — "" included — scatters the export across files.
      const written = writer.Perform(docHandle, fileName, progress);
      progress.delete();
      writer.delete();
      if (!written) {
        throw new Error('STEP assembly write failed');
      }

      const file = oc.FS.readFile(fileName, { encoding: "utf8" }) as string;
      try {
        oc.FS.unlink(fileName);
      } catch { /* already gone */ }
      return file;
    } finally {
      cleanup();
    }
  }

  private static addPrototype(
    part: AssemblyExportPart,
    shapeTool: XCAFDoc_ShapeTool,
    colorTool: XCAFDoc_ColorTool,
    surfType: XCAFDoc_ColorType,
    includeColors: boolean,
    disposers: (() => void)[],
  ): TDF_Label {
    const oc = getOC();
    const conformed = part.solids.map(solid => StepConform.conformSolid(solid.getShape()));
    disposers.push(() => {
      for (const c of conformed) {
        c.delete();
      }
    });

    // A one-solid part is the solid itself; several become one compound so
    // the part stays one product with one shape representation.
    let shape: TopoDS_Shape = conformed[0].shape;
    if (conformed.length > 1) {
      const compound = OcIO.makeCompoundRaw(conformed.map(c => c.shape));
      disposers.push(() => compound.delete());
      shape = compound;
    }

    const label = shapeTool.NewShape();
    shapeTool.SetShape(label, shape);
    OcAssemblyStep.nameLabel(label, part.name);

    if (includeColors) {
      part.solids.forEach((solid, i) => {
        for (const entry of solid.colorMap) {
          const [r, g, b] = OcIO.hexToRgb(entry.color);
          const color = new oc.Quantity_Color(r, g, b, oc.Quantity_TypeOfColor.Quantity_TOC_RGB);
          colorTool.SetColor(conformed[i].replacement(entry.shape), color, surfType);
          color.delete();
        }
      });
    }
    return label;
  }

  /** Adds `nodes` under `parent`, skipping subtrees with nothing to write. */
  private static addComponents(
    parent: TDF_Label,
    nodes: AssemblyExportNode[],
    parts: Map<string, AssemblyExportPart>,
    prototypes: Map<string, TDF_Label>,
    shapeTool: XCAFDoc_ShapeTool,
    disposers: (() => void)[],
  ): void {
    for (const node of nodes) {
      if (!nodeHasSolids(node, parts)) {
        continue;
      }
      const location = OcAssemblyStep.locationOf(node.pose, disposers);
      if (node.kind === 'instance') {
        const prototype = prototypes.get(node.partId)!;
        const reference = shapeTool.AddComponent(parent, prototype, location);
        OcAssemblyStep.nameLabel(reference, node.name);
        continue;
      }
      const occurrence = shapeTool.NewShape();
      OcAssemblyStep.nameLabel(occurrence, node.name);
      OcAssemblyStep.addComponents(occurrence, node.children, parts, prototypes, shapeTool, disposers);
      const reference = shapeTool.AddComponent(parent, occurrence, location);
      OcAssemblyStep.nameLabel(reference, node.name);
    }
  }

  private static locationOf(pose: Pose, disposers: (() => void)[]) {
    const oc = getOC();
    const [trsf, disposeTrsf] = Convert.toGpTrsfPose(pose.position, pose.quaternion);
    const location = new oc.TopLoc_Location(trsf);
    disposers.push(() => {
      location.delete();
      disposeTrsf();
    });
    return location;
  }

  /** The label's `TDataStd_Name` — what the STEP writer emits as the PRODUCT / NAUO name. */
  private static nameLabel(label: TDF_Label, name: string): void {
    const oc = getOC();
    const text = new oc.TCollection_ExtendedString(name);
    oc.TDataStd_Name.Set(label, text);
    text.delete();
  }
}
