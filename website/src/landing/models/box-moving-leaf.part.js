import { part, sketch, line, circle, plane, extrude, cut, repeat, connector, color, origin, select, chamfer } from "fluidcad/core";
import { edge } from "fluidcad/filters";
import { coincident, horizontal, vertical, fix, distance, diameter } from "fluidcad/constraints";

// ASSUMPTION: mm; hinge axis is Z, with the lower end at the origin.
const hingeLength = 50;
const leafReach = 30;
const rootClearance = 5.5;
const plateThickness = 3;
const barrelDiameter = 10;
const boreDiameter = 5.4;
const knucklePitch = 10;
const axialClearance = 0.4;
const knuckleLength = knucklePitch-axialClearance;
const mountDiameter = 4.5; // ASSUMPTION: M4 clearance holes.
// ASSUMPTION: 90-degree countersinks, 8.5 mm mouth, 2 mm deep; 1 mm straight bore remains.
const countersinkDiameter = 8.5;
const countersinkDepth = (countersinkDiameter-mountDiameter)/2;
const mountX = 20;
const mountEndMargin = 10;
// ASSUMPTION: 0.4 mm axial gaps; Ø5 pin in Ø5.4 bores.
export const movingLeaf = part("Box hinge — moving leaf", () => {
sketch("xy", () => {
const b = line([rootClearance,-barrelDiameter/2],[leafReach,-barrelDiameter/2]);
const r = line([leafReach,-barrelDiameter/2],[leafReach,-barrelDiameter/2+plateThickness]);
const t = line([leafReach,-barrelDiameter/2+plateThickness],[rootClearance,-barrelDiameter/2+plateThickness]);
const l = line([rootClearance,-barrelDiameter/2+plateThickness],[rootClearance,-barrelDiameter/2]);
coincident(b.end(),r.start()); coincident(r.end(),t.start());
coincident(t.end(),l.start()); coincident(l.end(),b.start());
horizontal(b); vertical(r); horizontal(t); vertical(l);
fix(b.start(),[rootClearance,-barrelDiameter/2]);
distance(b.start(),b.end(),(leafReach)-(rootClearance));
distance(r.start(),r.end(),(-barrelDiameter/2+plateThickness)-(-barrelDiameter/2));
});
extrude(hingeLength);
sketch(plane("xy", knucklePitch+axialClearance/2), () => {
const b = line([0,-barrelDiameter/2],[rootClearance,-barrelDiameter/2]);
const r = line([rootClearance,-barrelDiameter/2],[rootClearance,-barrelDiameter/2+plateThickness]);
const t = line([rootClearance,-barrelDiameter/2+plateThickness],[0,-barrelDiameter/2+plateThickness]);
const l = line([0,-barrelDiameter/2+plateThickness],[0,-barrelDiameter/2]);
coincident(b.end(),r.start()); coincident(r.end(),t.start());
coincident(t.end(),l.start()); coincident(l.end(),b.start());
horizontal(b); vertical(r); horizontal(t); vertical(l);
fix(b.start(),[0,-barrelDiameter/2]);
distance(b.start(),b.end(),(rootClearance)-(0));
distance(r.start(),r.end(),(-barrelDiameter/2+plateThickness)-(-barrelDiameter/2));
});
const web = extrude(knuckleLength);
sketch(plane("xy", knucklePitch+axialClearance/2), () => {
const barrel = circle([0,0],barrelDiameter);
coincident(barrel.center(),origin()); diameter(barrel,barrelDiameter);
});
const knuckle = extrude(knuckleLength);
repeat("linear","z",{count:2,offset:2*knucklePitch},web,knuckle);
sketch(plane("xy", hingeLength), () => {
const c = circle([0,0],boreDiameter);
coincident(c.center(),origin()); diameter(c,boreDiameter);
});
const pinBore = cut(hingeLength);
sketch(plane("xz",barrelDiameter/2), () => {
const h = circle([mountX,mountEndMargin],mountDiameter);
fix(h.center(),[mountX,mountEndMargin]); diameter(h,mountDiameter);
});
const mountingHole = cut(plateThickness);
repeat("linear","z",{count:2,offset:hingeLength-2*mountEndMargin},mountingHole);
connector("pivot",plane("xy"));
color("#B8C9B0");
chamfer(countersinkDepth, select(edge().onPlane('yz', mountX).farthest('y')));
});
