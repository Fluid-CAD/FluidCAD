import { part, sketch, extrude, cut, plane, color, connector, fillet } from "fluidcad/core";
import { disk, rectangle, capsuleY } from "./profiles.js";
import { D } from "./dimensions.js";

// Origin on the underside of the foot; the panel's rear face is local Z = 0.
export const frame = part("Open pedestal frame", () => {
  sketch("xz", () => rectangle(-D.footWidth / 2, D.footBack, D.footWidth, D.footDepth));
  const foot = extrude(-D.footHeight);
  sketch("xy", () => rectangle(-D.frameWidth / 2, D.footHeight, D.frameWidth, D.frameHeight - D.footHeight));
  extrude(D.panelDepth);
  sketch("xy", () => {
    capsuleY(-72, 55, 242, 26);
    capsuleY(58, 100, 225, 40);
  });
  cut(-D.panelDepth);
  sketch(plane("xy", D.panelDepth), () => disk(D.crankX, D.crankY, D.crankBossDiameter));
  extrude(D.crankDepth - D.panelDepth);
  sketch(plane("xy", D.panelDepth), () => disk(D.anchorX, D.anchorY, 36));
  extrude(D.linkDepth - D.panelDepth);
  sketch(plane("xy", D.panelDepth), () => {
    rectangle(-105, D.frameHeight - 5, 20, 5);
    rectangle(85, D.frameHeight - 5, 20, 5);
  });
  extrude(D.guideRear - D.panelDepth);
  sketch("xy", () => {
    disk(D.crankX, D.crankY, D.pivotClearance);
    disk(D.anchorX, D.anchorY, D.pivotClearance);
  });
  cut(-D.linkDepth);
  fillet(D.cornerRadius, foot.sideEdges()).name("Rounded foot corners");
  color(D.frameColor);
  connector("crank", plane("xy", D.crankDepth)).offset(D.crankX, D.crankY);
  connector("anchor", plane("xy", D.linkDepth)).offset(D.anchorX, D.anchorY);
  connector("guide", plane("xy")).offset(0, D.ramY);
  connector("ram", plane("xy", D.ramDepth)).offset(0, D.ramY).rotate("y", 90);
  connector("crankBolt", plane("xy", D.crankDepth + D.crankThickness + 0.5)).offset(D.crankX, D.crankY);
  connector("anchorBolt", plane("xy", D.linkDepth + D.linkThickness + 0.5)).offset(D.anchorX, D.anchorY);
});
