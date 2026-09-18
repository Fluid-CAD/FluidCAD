import { part, sketch, circle, plane, extrude, connector, color, origin } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

// ASSUMPTION: removable headed pin; no retaining clip or interference fit.
// Pin axis Z, bottom tip at origin; head underside at z=50.
const shaftDiameter = 5;
const shaftLength = 50;
const headDiameter = 8.5;
const headThickness = 2;
export const hingePin = part("Hinge pin", () => {
  sketch("xy", () => {
    const c = circle([0,0],shaftDiameter);
    coincident(c.center(),origin()); diameter(c,shaftDiameter);
  });
  extrude(shaftLength);
  sketch(plane("xy",shaftLength), () => {
    const h = circle([0,0],headDiameter);
    coincident(h.center(),origin()); diameter(h,headDiameter);
  });
  extrude(headThickness);
  connector("axis",plane("xy"));
  color("#D7CEC0");
});
