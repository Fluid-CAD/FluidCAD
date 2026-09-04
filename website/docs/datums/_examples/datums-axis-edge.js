// @screenshot showAxes
import { sketch, extrude, axis, rotate, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A cabinet with a door: the door swings open around the cabinet's front
// edge, and that axis is read from the cabinet itself.
sketch("xy", () => {
    const b = line([-30, 0], [30, 0]);
    const r = line([30, 0], [30, 40]);
    const t = line([30, 40], [-30, 40]);
    const l = line([-30, 40], [-30, 0]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-30, 0]);
    distance(b.start(), b.end(), 60);
    distance(r.start(), r.end(), 40);
});
const cabinet = extrude(80);

// The door: a 3 thick panel in front of the cabinet, kept a separate body.
sketch("xy", () => {
    const b = line([-30, -3], [30, -3]);
    const r = line([30, -3], [30, 0]);
    const t = line([30, 0], [-30, 0]);
    const l = line([-30, 0], [-30, -3]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-30, -3]);
    distance(b.start(), b.end(), 60);
    distance(r.start(), r.end(), 3);
});
const door = extrude(80).new();

// highlight-start
// The hinge axis, read off the cabinet: its first vertical edge is the
// front-left corner. No coordinates typed — resize the cabinet and the hinge
// stays on the corner.
const hinge = axis(cabinet.sideEdges(0));
// highlight-end

// Swing the door open by 70° around the hinge.
rotate(hinge, -70, door);
