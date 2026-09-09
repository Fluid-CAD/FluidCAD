// @screenshot skip
import { part, sketch, line, extrude, color, select, connector } from 'fluidcad/core';
import { face } from 'fluidcad/filters';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A 30 mm carriage that straddles the rail: a U profile on the YZ plane —
// 30 wide, 20 tall, with a 20.4 × 12 groove that rests on the rail's top
// and clears its sides by 0.2 — extruded along X.
export const carriage = part('Carriage', () => {
    sketch('yz', () => {
        const l1 = line([-15, 0], [-10.2, 0]);
        const l2 = line([-10.2, 0], [-10.2, 12]);
        const l3 = line([-10.2, 12], [10.2, 12]);
        const l4 = line([10.2, 12], [10.2, 0]);
        const l5 = line([10.2, 0], [15, 0]);
        const l6 = line([15, 0], [15, 20]);
        const l7 = line([15, 20], [-15, 20]);
        const l8 = line([-15, 20], [-15, 0]);
        coincident(l1.end(), l2.start());
        coincident(l2.end(), l3.start());
        coincident(l3.end(), l4.start());
        coincident(l4.end(), l5.start());
        coincident(l5.end(), l6.start());
        coincident(l6.end(), l7.start());
        coincident(l7.end(), l8.start());
        coincident(l8.end(), l1.start());
        horizontal(l1);
        horizontal(l3);
        horizontal(l5);
        horizontal(l7);
        vertical(l2);
        vertical(l4);
        vertical(l6);
        vertical(l8);
        fix(l8.start(), [-15, 20]);
        distance(l7.start(), l7.end(), 30);
        distance(l8.start(), l8.end(), 20);
        distance(l3.start(), l3.end(), 20.4);
        distance(l2.start(), l2.end(), 12);
    });
    extrude(30);
    color('steelblue');
    // The groove ceiling, built like the rail's `track` frame: X across the
    // carriage (world Y), then turned 90° about that X so Z runs along it.
    connector('slide', select(face().planar().onPlane('xy', 12)), { xDirection: 'y' }).rotate('x', 90);
});
