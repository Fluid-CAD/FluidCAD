import { part, param, sketch, extrude, cut, plane, color, connector } from "fluidcad/core";
import { disk, rectangle } from "./profiles.js";
import { D } from "./dimensions.js";

// ASSUMPTION: plain pivot fasteners with cosmetic screwdriver slots, no threads.
export const bolt = part("Shouldered pivot fastener", () => {
  const shaftDiameter = param("Shaft diameter", 12);
  const shaftLength = param("Shaft length", 20);
  const headDiameter = param("Head diameter", 20);
  const headHeight = 3;
  const slotWidth = 2;
  const slotDepth = 1.2;
  sketch("xy", () => disk(0, 0, shaftDiameter));
  extrude(-shaftLength);
  sketch("xy", () => disk(0, 0, headDiameter));
  extrude(headHeight);
  sketch(plane("xy", headHeight), () =>
    rectangle(-headDiameter * 0.3, -slotWidth / 2, headDiameter * 0.6, slotWidth));
  cut(slotDepth);
  color(D.pinColor);
  connector("seat", plane("xy"));
});
