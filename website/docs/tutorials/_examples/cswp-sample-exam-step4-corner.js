// @screenshot waitForInput
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

// L-shaped support
sketch("xy", () => {
    const l1 = line([leftOffset, 0], [leftOffset, 80]);
    const a = arc([leftOffset, 80], [B - 80, C], [leftOffset, C]);
    const l2 = line([B, C], [B - 80, C]);
    coincident(l1.end(), a.start());
    coincident(l2.end(), a.end());
    vertical(l1);
    horizontal(l2);
    fix(l1.start(), [leftOffset, 0]);
    fix(l2.start(), [B, C]);
    radius(a, C - 80);
    offset(15, l1, a, l2).close();
});

const support = extrude(95)

// Pipe 1 — front
const p1 = plane("front", 10);

sketch(p1, () => {
    const c = circle([leftOffset + 7.5, 95], X);
    fix(c.center(), [leftOffset + 7.5, 95]);
    diameter(c, X);
});

const cylBody1 = extrude(-D)
sketch(cylBody1.startFaces(), () => {
    const rim = project(cylBody1.startFaces()).guide();
    const bore = circle([0, 0], E);
    concentric(bore, rim);
    diameter(bore, E);
})
const cylCut1 = cut()

chamfer(2, cylCut1.startEdges(), cylCut1.endEdges())

// Pipe 2 — right
const p2 = plane("right", B + 10)

sketch(p2, () => {
    const c = circle([C - 7.5, 95], Y);
    fix(c.center(), [C - 7.5, 95]);
    diameter(c, Y);
});

const cylBody2 = extrude(-D)
sketch(cylBody2.startFaces(), () => {
    const rim = project(cylBody2.startFaces()).guide();
    const bore = circle([0, 0], E);
    concentric(bore, rim);
    diameter(bore, E);
})
const cylCut2 = cut()

chamfer(2, cylCut2.startEdges(), cylCut2.endEdges())

// Corner block
sketch("xy", () => {
    const cb = line([B, 0], [B - 60, 0]);
    const cr = line([B - 60, 0], [B - 60, 60]);
    const ct = line([B - 60, 60], [B, 60]);
    const cl = line([B, 60], [B, 0]);
    coincident(cb.end(), cr.start());
    coincident(cr.end(), ct.start());
    coincident(ct.end(), cl.start());
    coincident(cl.end(), cb.start());
    horizontal(cb);
    vertical(cr);
    horizontal(ct);
    vertical(cl);
    fix(cb.start(), [B, 0]);
    distance(cb.start(), cb.end(), 60);
    distance(cr.start(), cr.end(), 60);
    fillet(10, cl, cb);
    fillet(15, cr, ct);
});

const corner = extrude(35);
