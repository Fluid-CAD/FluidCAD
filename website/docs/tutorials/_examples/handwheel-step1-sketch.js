import { sketch, circle, line, origin, extrude, project, cut, repeat, select, fillet, chamfer, color } from "fluidcad/core";
import { coincident, diameter, horizontal, vertical, distance, concentric, equal, fix, tangent, angle } from "fluidcad/constraints";

import { edge } from "fluidcad/filters";

// Dimensions are in millimetres, the browser viewer's default unit.

// ASSUMPTION: a compact workshop handwheel, flat underside on XY and shaft on Z.
const wheelDiameter = 75;
const rimWidth = 8;
const rimInnerDiameter = wheelDiameter - 2 * rimWidth;
const hubDiameter = 24;
const spokeWidth = 8;
const spokeHeight = 5;
const spokeCount = 4;
const spokeLength = rimInnerDiameter / 2 + rimWidth / 2;
const rimHeight = 10;
const hubHeight = 16;
// ASSUMPTION: nominal M6 hardware envelope; verify fit with the actual bolt and printer.
const shaftDiameter = 6.6;
const headAcrossFlats = 10.4;
const headPocketDepth = 4.5;
const scallopDiameter = 12;
const scallopDepth = 1.5;
const scallopCenterRadius = wheelDiameter / 2 + scallopDiameter / 2 - scallopDepth;
const scallopCount = 12;
const junctionRadius = 2;
const gripRadius = 1.5;
const scallopBlendRadius = 2;
const hubEdgeRadius = 1;
const pocketChamfer = 0.4;

// 1. A simple annular sketch makes the grip rim.
const rimSketch = sketch("xy", () => {
  const outer = circle([0, 0], wheelDiameter);
  const inner = circle([0, 0], rimInnerDiameter);
  coincident(outer.center(), origin());
  concentric(inner, outer);
  diameter(outer, wheelDiameter);
  diameter(inner, rimInnerDiameter);
}).name("Rim sketch");
