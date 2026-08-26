import { arc, chamfer, circle, cut, extrude, fillet, line, offset, plane, project, select, sketch } from 'fluidcad/core';
import { coincident, concentric, diameter, distance, fix, horizontal, radius, tangent, vertical } from 'fluidcad/constraints';
import { edge, face } from 'fluidcad/filters';

// CSWP Exam Parameters — Stage 1
const A = 213;
const B = 200;
const C = 170;
const D = 130;
const E = 41;
const X = A / 3;
const Y = B / 3 + 10;

const leftOffset = B - C;

// Base plate
sketch("xy", () => {
    const b = line([0, 0], [B, 0]);
    const r = line([B, 0], [B, A]);
    const t = line([B, A], [0, A]);
    const l = line([0, A], [0, 0]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [0, 0]);
    distance(b.start(), b.end(), B);
    distance(r.start(), r.end(), A);
    fillet(10, b, r, t, l);
})

const base = extrude(25);
