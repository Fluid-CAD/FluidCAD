import { assembly, insert, mate } from "fluidcad/core";
import { fixedLeaf } from "./box-fixed-leaf.part.js";
import { movingLeaf } from "./box-moving-leaf.part.js";
import { hingePin } from "./box-pin.part.js";

// ASSUMPTION: 50 mm box hinge, shown flat on the XY ground plane; travel 0–180 degrees.
// Five alternating knuckles: three fixed, two moving. Pin remains removable.
const initialOpening = 0;
const axisHeight = 5; // barrel radius: leaf underside and barrel tangent sit at z=0.
const halfLength = 25; // center the 50 mm hinge along Y.
export const boxHinge = assembly("Box hinge — two leaves and pin", () => {
  const fixed = insert(fixedLeaf).rotate("x",90).translate(0,halfLength,axisHeight).grounded().name("Fixed leaf — 3 knuckles");
  const moving = insert(movingLeaf).rotate("z",initialOpening).rotate("x",90).translate(0,halfLength,axisHeight).name("Moving leaf — 2 knuckles");
  const pin = insert(hingePin).rotate("x",90).translate(0,halfLength,axisHeight).name("Headed hinge pin");
  mate("revolute",fixed.connectors.pivot,moving.connectors.pivot).flip().limits(0,180).name("hinge-swing");
  mate("fastened",fixed.connectors.pivot,pin.connectors.axis).flip().name("pin-seat");
});
