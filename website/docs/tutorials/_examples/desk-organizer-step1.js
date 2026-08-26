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
