import { arc, chamfer, cut, extrude, fillet, line, plane, sketch } from "fluidcad/core";
import { edge } from "fluidcad/filters";
import { coincident, distance, fix, horizontal, radius, vertical } from "fluidcad/constraints";

let supportWidth = (150 - 63) / 2;
let supportThickness = 12;

sketch("xy", () => {
    const b = line([63 / 2, -115 / 2], [63 / 2 + supportWidth, -115 / 2]);
    const r = line([63 / 2 + supportWidth, -115 / 2], [63 / 2 + supportWidth, 115 / 2]);
    const t = line([63 / 2 + supportWidth, 115 / 2], [63 / 2, 115 / 2]);
    const l = line([63 / 2, 115 / 2], [63 / 2, -115 / 2]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [63 / 2, -115 / 2]);
    distance(b.start(), b.end(), supportWidth);
    distance(r.start(), r.end(), 115);
});

const e1 = extrude(supportThickness);

fillet(12, e1.sideEdges(2, 3));

chamfer(8, 90 - 25, true, e1.endEdges(edge().onPlane('yz', 31.5)))

sketch("top", () => {
    const sg1 = line([-58, -38.5], [58, -38.5]);
    const sg2 = line([58, -38.5], [58, 38.5]);
    const sg3 = line([58, 38.5], [-58, 38.5]);
    const sg4 = line([-58, 38.5], [-58, -38.5]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-58, -38.5]);
    distance(sg1.start(), sg1.end(), 116);
    distance(sg2.start(), sg2.end(), 77);
  });

const e2 = extrude(130);
const rightPlane = plane(e1.sideFaces(2))

sketch(e2.endFaces(), () => {
    const sg5 = line([-58, -34], [58, -34]);
    const sg6 = line([58, -34], [58, 34]);
    const sg7 = line([58, 34], [-58, 34]);
    const sg8 = line([-58, 34], [-58, -34]);
    coincident(sg5.end(), sg6.start());
    coincident(sg6.end(), sg7.start());
    coincident(sg7.end(), sg8.start());
    coincident(sg8.end(), sg5.start());
    horizontal(sg5);
    vertical(sg6);
    horizontal(sg7);
    vertical(sg8);
    fix(sg5.start(), [-58, -34]);
    distance(sg5.start(), sg5.end(), 116);
    distance(sg6.start(), sg6.end(), 68);
  });

const e3 = extrude(168 - 130);

chamfer(8, e3.endEdges());

const p1 = plane("xy");
sketch(p1, () => {
    const sg9 = line([-50, -31], [50, -31]);
    const sg10 = line([50, -31], [50, 31]);
    const sg11 = line([50, 31], [-50, 31]);
    const sg12 = line([-50, 31], [-50, -31]);
    coincident(sg9.end(), sg10.start());
    coincident(sg10.end(), sg11.start());
    coincident(sg11.end(), sg12.start());
    coincident(sg12.end(), sg9.start());
    horizontal(sg9);
    vertical(sg10);
    horizontal(sg11);
    vertical(sg12);
    fix(sg9.start(), [-50, -31]);
    distance(sg9.start(), sg9.end(), 100);
    distance(sg10.start(), sg10.end(), 62);
  });

cut(-158).draft(-3)

sketch(rightPlane, () => {
    const b = line([-10, 12], [10, 12]);
    const r = line([10, 12], [10, 16]);
    const t = line([10, 16], [-10, 16]);
    const l = line([-10, 16], [-10, 12]);
    const cap = arc([10, 16], [-10, 16], [0, 16]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    coincident(cap.start(), t.start());
    coincident(cap.end(), t.end());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    radius(cap, 10);
    fix(b.start(), [-10, 12]);
    distance(b.start(), b.end(), 20);
    distance(r.start(), r.end(), 4);
});
