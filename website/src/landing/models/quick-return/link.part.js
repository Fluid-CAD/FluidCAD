import { part, sketch, extrude, cut, plane, color, connector, chamfer } from "fluidcad/core";
import { disk, capsule } from "./profiles.js";
import { D } from "./dimensions.js";

// Fixed lower frame pivot at origin; arm-end pivot at +X.
export const link = part("Lower rocking link", () => {
  sketch("xy", () => {
    capsule(0, D.linkLength, 0, 13);
    disk(0, 0, D.pivotClearance);
    disk(D.linkLength, 0, D.jointClearance);
  });
  const body = extrude(D.linkThickness);
  color(D.linkColor);
  connector("fixed", plane("xy"));
  connector("arm", plane("xy")).offset(D.linkLength, 0);
});
