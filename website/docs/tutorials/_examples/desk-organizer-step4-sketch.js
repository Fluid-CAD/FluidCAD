// @screenshot waitForInput
import { plane, sketch, extrude, fillet, chamfer, repeat, rotate, arc, shell, offset, rib, revolve, line, xAxis } from 'fluidcad/core';
import { angle, coincident, distance, equal, fix, horizontal, radius, vertical } from "fluidcad/constraints";

sketch("top", () => {
    const s1 = line([75.767454, 0], [53.575681, 53.575681]);
    const s2 = line([53.575681, 53.575681], [0, 75.767454]);
    const s3 = line([0, 75.767454], [-53.575681, 53.575681]);
    const s4 = line([-53.575681, 53.575681], [-75.767454, 0]);
    const s5 = line([-75.767454, 0], [-53.575681, -53.575681]);
    const s6 = line([-53.575681, -53.575681], [0, -75.767454]);
    const s7 = line([0, -75.767454], [53.575681, -53.575681]);
    const s8 = line([53.575681, -53.575681], [75.767454, 0]);
    coincident(s1.end(), s2.start());
    coincident(s2.end(), s3.start());
    coincident(s3.end(), s4.start());
    coincident(s4.end(), s5.start());
    coincident(s5.end(), s6.start());
    coincident(s6.end(), s7.start());
    coincident(s7.end(), s8.start());
    coincident(s8.end(), s1.start());
    equal(s1, s2);
    equal(s1, s3);
    equal(s1, s4);
    equal(s1, s5);
    equal(s1, s6);
    equal(s1, s7);
    equal(s1, s8);
    rotate(45 / 2, [0, 0]);
    fillet(20, s1, s2, s3, s4, s5, s6, s7, s8);
});

const outer = extrude(110);

chamfer(8, outer.startEdges())

shell(-5, outer.endFaces())

sketch("top", () => {
    const sg1 = line([-25, -25], [25, -25]);
    const sg2 = line([25, -25], [25, 25]);
    const sg3 = line([25, 25], [-25, 25]);
    const sg4 = line([-25, 25], [-25, -25]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-25, -25]);
    distance(sg1.start(), sg1.end(), 50);
    distance(sg2.start(), sg2.end(), 50);
    offset(-5);
});

extrude(160);

const p = plane("front", { rotateY: 45 })

sketch(p, () => {
    const l = line([(-140 / 2) + 5, 110], [-50.857864, 124.142136]);
    fix(l.start(), [(-140 / 2) + 5, 110]);
    angle(xAxis(), l, 45);
    distance(l.start(), l.end(), 20);
});
