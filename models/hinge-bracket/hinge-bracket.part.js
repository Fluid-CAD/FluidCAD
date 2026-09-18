import { sketch, line, arc, circle, extrude, cut, plane, repeat, origin, part, connector, color } from "fluidcad/core";
import { coincident, horizontal, vertical, fix, distance, diameter, radius, tangent } from "fluidcad/constraints";

export const bracket = part("Hinge bracket", () => {
// ASSUMPTION: starter bracket in mm, base bottom centered at the origin.
const baseWidth = 60;
const baseDepth = 40;
const baseThickness = 6;
// ASSUMPTION: two 6 mm ears, 16 mm free gap, 24 mm width, pivot 26 mm above base bottom.
const earThickness = 6;
const earGap = 16;
const earWidth = 24;
const pivotHeight = 26;
// ASSUMPTION: nominal 8 mm pivot and four M5 clearance holes on a 44 x 24 mm pattern.
const pivotDiameter = 8;
const mountDiameter = 5.5;
const mountPitchX = 44;
const mountPitchY = 24;

sketch("xy", () => {
  const b = line([-baseWidth/2,-baseDepth/2],[baseWidth/2,-baseDepth/2]);
  const r = line([baseWidth/2,-baseDepth/2],[baseWidth/2,baseDepth/2]);
  const t = line([baseWidth/2,baseDepth/2],[-baseWidth/2,baseDepth/2]);
  const l = line([-baseWidth/2,baseDepth/2],[-baseWidth/2,-baseDepth/2]);
  coincident(b.end(),r.start()); coincident(r.end(),t.start());
  coincident(t.end(),l.start()); coincident(l.end(),b.start());
  horizontal(b); vertical(r); horizontal(t); vertical(l);
  fix(b.start(),[-baseWidth/2,-baseDepth/2]);
  distance(b.start(),b.end(),baseWidth);
  distance(r.start(),r.end(),baseDepth);
});
const base = extrude(baseThickness);

sketch(plane("xz", earGap/2), () => {
  const b = line([-earWidth/2,baseThickness],[earWidth/2,baseThickness]);
  const r = line([earWidth/2,baseThickness],[earWidth/2,pivotHeight]);
  const a = arc([earWidth/2,pivotHeight],[-earWidth/2,pivotHeight],[0,pivotHeight]);
  const l = line([-earWidth/2,pivotHeight],[-earWidth/2,baseThickness]);
  coincident(b.end(),r.start()); coincident(r.end(),a.start());
  coincident(a.end(),l.start()); coincident(l.end(),b.start());
  horizontal(b); vertical(r); vertical(l);
  tangent(r,a); tangent(a,l);
  fix(b.start(),[-earWidth/2,baseThickness]);
  distance(b.start(),b.end(),earWidth);
  distance(r.start(),r.end(),pivotHeight-baseThickness);
});
const ear = extrude(earThickness);
repeat("mirror", "xz", ear);

sketch(plane("xz", earGap/2+earThickness), () => {
  const bore = circle([0,pivotHeight],pivotDiameter);
  vertical(origin(),bore.center());
  distance(origin(),bore.center(),pivotHeight,"y");
  diameter(bore,pivotDiameter);
});
const pivot = cut(earGap+2*earThickness);

sketch("xy", () => {
  const mounting = circle([-mountPitchX/2,-mountPitchY/2],mountDiameter);
  fix(mounting.center(),[-mountPitchX/2,-mountPitchY/2]);
  diameter(mounting,mountDiameter);
});
const mountingHole = cut(-baseThickness);
repeat("linear", ["x","y"], {count:[2,2],offset:[mountPitchX,mountPitchY]}, mountingHole);

connector("pivot", plane("xz")).offset(0, pivotHeight, 0);
color("steelblue");
});
