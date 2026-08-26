// @screenshot waitForInput
import { arc, chamfer, circle, cut, extrude, fillet, line, offset, plane, project, select, sketch } from 'fluidcad/core';
import { coincident, concentric, diameter, distance, fix, horizontal, radius, tangent, vertical } from 'fluidcad/constraints';
import { edge, face } from 'fluidcad/filters';

// CSWP Exam Parameters — Stage 2
const A = 221;
const B = 211;
const C = 165;
const D = 121;
const E = 37;
const X = A / 3;
const Y = B / 3 + 15;

const leftOffset = B - C;

// Base plate (no corner radii in Stage 2)
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

// Pipe 1 — front (angled chamfer)
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

chamfer(2, 30, true, cylCut1.startEdges(), cylCut1.endEdges())

// Pipe 2 — right (angled chamfer)
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

chamfer(2, 30, true, cylCut2.startEdges(), cylCut2.endEdges())

// First pocket
const topFace1 = select(face().onPlane("xy", 25).edgeCount(5));

sketch(base.endFaces(), () => {
    const p = project(topFace1).guide();
    offset(-9, p);
});

let c1 = cut(20)

fillet(10, c1.internalEdges())

// Second pocket — sketch only (before cut)
sketch(base.endFaces(), () => {
    const outerOffset = 9;
    const l1 = line([outerOffset, A - outerOffset], [B - 80 - outerOffset, A - outerOffset]);
    const l2 = line([outerOffset, A - outerOffset], [outerOffset, 80 + outerOffset]);
    const l3 = line([outerOffset, 80 + outerOffset], [leftOffset, 80 + outerOffset]);
    const l4 = line([B - 80 - outerOffset, A - outerOffset], [B - 80 - outerOffset, C]);
    const a = arc([B - 80 - outerOffset, C], [leftOffset, 80 + outerOffset], [leftOffset, C]).cw();
    coincident(l1.start(), l2.start());
    coincident(l2.end(), l3.start());
    coincident(l1.end(), l4.start());
    coincident(l4.end(), a.start());
    coincident(l3.end(), a.end());
    horizontal(l1);
    vertical(l2);
    horizontal(l3);
    vertical(l4);
    tangent(l4, a);
    fix(l1.start(), [outerOffset, A - outerOffset]);
});
