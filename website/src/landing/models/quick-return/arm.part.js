import { part, sketch, extrude, cut, plane, color, connector, expose, select, chamfer } from "fluidcad/core";
import { face } from "fluidcad/filters";
import { disk, capsule } from "./profiles.js";
import { D } from "./dimensions.js";

// Lower pivot at local origin, upper ram joint along +X.
export const arm = part("Slotted driving arm", () => {
  sketch("xy", () => capsule(0, D.leverLength, 0, D.leverRadius));
  const body = extrude(D.leverThickness);
  sketch("xy", () => {
    capsule(D.slotStart, D.slotEnd, 0, D.slotWidth / 2);
    disk(0, 0, D.jointClearance);
    disk(D.leverLength, 0, D.jointClearance);
  });
  const openings = cut(-D.leverThickness);
  chamfer(D.edgeBreak, body.endEdges(), body.startEdges()).name("Arm edge breaks");
  color(D.leverColor);
  connector("lower", plane("xy", D.linkDepth - D.leverDepth));
  connector("upper", plane("xy")).offset(D.leverLength, 0);
  connector("lowerBolt", plane("xy", D.linkDepth + D.linkThickness + 0.5 - D.leverDepth));
  expose("slotWall", select(face().planar().onPlane("xz", -D.slotWidth / 2)));
});
