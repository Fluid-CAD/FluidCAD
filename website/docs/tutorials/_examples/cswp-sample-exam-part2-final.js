// @screenshot waitForInput
import { arc, chamfer, circle, cut, extrude, fillet, hLine, hMove, line, move, offset, plane, project, rect, select, sketch, subtract, tArc, vLine, vMove } from 'fluidcad/core';
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
    rect(B, A);
})

const base = extrude(25);

// L-shaped support
sketch("xy", () => {
    move([leftOffset, 0]);
    const l1 = vLine(80)

    move([B, C]);
    const l2 = hLine(-80)

    arc(l1.end(), l2.end()).center([leftOffset, C])

    const o = offset(15)
    line(l1.start(), o.start())
    line(l2.start(), o.end())
});

const support = extrude(95)

// Pipe 1 — front (angled chamfer)
const p1 = plane("front", 10);

sketch(p1, () => {
    move([leftOffset, 95]);
    hMove(7.5)
    circle(X)
});

const cylBody1 = extrude(-D)
circle(E, cylBody1.startFaces())
const cylCut1 = cut()

chamfer(2, 30, true, cylCut1.startEdges(), cylCut1.endEdges())

// Pipe 2 — right (angled chamfer)
const p2 = plane("right", B + 10)

sketch(p2, () => {
    move([C - 7.5, 95]);
    circle(Y)
});

const cylBody2 = extrude(-D)
circle(E, cylBody2.startFaces())
const cylCut2 = cut()

chamfer(2, 30, true, cylCut2.startEdges(), cylCut2.endEdges())

// First pocket
const topFace1 = select(face().onPlane("xy", 25).edgeCount(5));

sketch(base.endFaces(), () => {
    project(topFace1);
    offset(-9, true)
});

let c1 = cut(20)

fillet(10, c1.internalEdges())

// Second pocket
sketch(base.endFaces(), () => {
    const outerOffset = 9;
    move([0, 0])
    vMove(A - outerOffset)
    hMove(outerOffset)
    const l1 = hLine(B - 80 - outerOffset * 2)
    const l2 = vLine(l1.start(), -A + 80 + outerOffset * 2)
    const l3 = hLine(l2.end(), B - C - outerOffset)
    const l4 = vLine(l1.end(), -A + C + outerOffset)
    tArc(l4.end(), l3.end(), l4.tangent())
});

const c2 = cut(20)

fillet(10, c2.internalEdges())

// Key slot on pipe 1
sketch(plane(cylBody1.startFaces(), -30), () => {
    let p = project(cylBody1.startFaces());
    let o = offset(-10)
    move(p.end())
    let r = rect(15).centered('horizontal')
    const s = subtract(p, r)
    subtract(s, o)
});

cut(30);

// Base side fillets
fillet(10, base.sideEdges())
