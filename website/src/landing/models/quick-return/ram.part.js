import { part, sketch, extrude, cut, plane, color, connector } from "fluidcad/core";
import { disk, rectangle } from "./profiles.js";
import { D } from "./dimensions.js";

// Slider datum at the rear face, centred on its arm joint.
export const ram = part("Horizontal ram", () => {
  const noseWidth = 22;
  const noseHeight = 25;
  const jointBossDiameter = 20;
  const jointStandOff = D.leverDepth - D.ramDepth - D.ramThickness;
  sketch("xy", () => rectangle(D.ramLeft, -D.ramHalfHeight, D.ramLength, D.ramHalfHeight * 2));
  extrude(D.ramThickness);
  sketch("xy", () => rectangle(D.ramLeft + D.ramLength - noseWidth, D.ramHalfHeight, noseWidth, noseHeight));
  extrude(D.ramThickness);
  sketch(plane("xy", D.ramThickness), () => disk(0, 0, jointBossDiameter));
  extrude(jointStandOff);
  sketch("xy", () => disk(0, 0, D.jointClearance));
  cut(-(D.ramThickness + jointStandOff));
  color(D.ramColor);
  connector("slide", plane("xy")).rotate("y", 90);
  connector("arm", plane("xy", D.leverDepth - D.ramDepth));
  connector("bolt", plane("xy", D.leverDepth + D.leverThickness + 0.5 - D.ramDepth));
});
