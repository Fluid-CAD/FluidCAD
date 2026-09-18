import { part, sketch, extrude, plane, color, connector, expose, select } from "fluidcad/core";
import { face } from "fluidcad/filters";
import { disk } from "./profiles.js";
import { D } from "./dimensions.js";

// Seat is on the crank front face. Exact 16 mm contact diameter matches the slot.
export const pin = part("Crank sliding pin", () => {
  const rollerLength = D.leverDepth + D.leverThickness - D.crankDepth - D.crankThickness;
  const capGap = 0.5;
  const capThickness = 3;
  sketch("xy", () => disk(0, 0, D.jointDiameter));
  extrude(-D.crankThickness);
  sketch("xy", () => disk(0, 0, D.jointDiameter));
  extrude(rollerLength + capGap + capThickness);
  sketch("xy", () => disk(0, 0, D.slotWidth));
  extrude(rollerLength);
  sketch(plane("xy", rollerLength + capGap), () => disk(0, 0, 22));
  extrude(capThickness);
  color(D.pinColor);
  connector("seat", plane("xy"));
  expose("tread", select(face().cylinder(D.slotWidth)));
});
