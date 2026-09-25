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
const rim = extrude(rimHeight, rimSketch).name("Rim");

// 2. One rectangular spoke reaches from the center into the rim.
const spokeSketch = sketch("xy", () => {
  const b = line([0, -spokeWidth/2], [spokeLength, -spokeWidth/2]);
  const r = line([spokeLength, -spokeWidth/2], [spokeLength, spokeWidth/2]);
  const t = line([spokeLength, spokeWidth/2], [0, spokeWidth/2]);
  const l = line([0, spokeWidth/2], [0, -spokeWidth/2]);
  coincident(b.end(), r.start()); coincident(r.end(), t.start());
  coincident(t.end(), l.start()); coincident(l.end(), b.start());
  horizontal(b); horizontal(t); vertical(r); vertical(l);
  fix(b.start(), [0, -spokeWidth/2]);
  distance(b.start(), b.end(), spokeLength);
  distance(r.start(), r.end(), spokeWidth);
}).name("Spoke sketch");
const spoke = extrude(spokeHeight, spokeSketch).name("Spoke");
const spokePattern = repeat("circular", "z", { count: spokeCount, angle: 360 }, spoke).name("Spokes");

// 3. The central hub has its own single-circle sketch.
const hubSketch = sketch("xy", () => {
  const center = circle([0, 0], hubDiameter);
  coincident(center.center(), origin());
  diameter(center, hubDiameter);
}).name("Hub sketch");
const hub = extrude(hubHeight, hubSketch).name("Hub");

// 4. A separate circle makes the through bore.
const shaftSketch = sketch(hub.endFaces(), () => {
  const hubReference = project(hub.endEdges()).guide();
  const bolt = circle([0, 0], shaftDiameter);
  concentric(bolt, hubReference);
  diameter(bolt, shaftDiameter);
}).name("Bore sketch");
const shaft = cut(shaftSketch).name("Bore");

// 5. A regular hexagon makes the bolt-head seat.
const headSketch = sketch(hub.endFaces(), () => {
  const hubReference = project(hub.endEdges()).guide();
  const headDiameter = headAcrossFlats / Math.cos(Math.PI/6);
  const headRadius = headDiameter/2;
  const hexGuide = circle([0, 0], headAcrossFlats).guide();
  concentric(hexGuide, hubReference);
  diameter(hexGuide, headAcrossFlats);

  const h0 = line([headRadius, 0], [headRadius/2, headAcrossFlats/2]);
  const h1 = line([headRadius/2, headAcrossFlats/2], [-headRadius/2, headAcrossFlats/2]);
  const h2 = line([-headRadius/2, headAcrossFlats/2], [-headRadius, 0]);
  const h3 = line([-headRadius, 0], [-headRadius/2, -headAcrossFlats/2]);
  const h4 = line([-headRadius/2, -headAcrossFlats/2], [headRadius/2, -headAcrossFlats/2]);
  const h5 = line([headRadius/2, -headAcrossFlats/2], [headRadius, 0]);
  coincident(h0.end(), h1.start()); coincident(h1.end(), h2.start());
  coincident(h2.end(), h3.start()); coincident(h3.end(), h4.start());
  coincident(h4.end(), h5.start()); coincident(h5.end(), h0.start());
  tangent(h0, hexGuide); tangent(h1, hexGuide);
  tangent(h2, hexGuide); tangent(h3, hexGuide);
  tangent(h4, hexGuide); tangent(h5, hexGuide);
  equal(h0, h1, h2, h3, h4);
  angle(h0, h1, 60);
  horizontal(h1);

}).name("Head sketch");
