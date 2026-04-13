// @screenshot waitForInput
import { arc, chamfer, circle, cut, extrude, fillet, hLine, hMove, line, move, offset, plane, project, rect, select, sketch, subtract, tArc, vLine, vMove } from 'fluidcad/core';
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
    rect(B, A).radius(10);
})

const base = extrude(25);

// L-shaped support
sketch("xy", () => {
    move([leftOffset, 0]);
    const l1 = vLine(80)

    move([B, C]);
    const l2 = hLine(-80)

    arc(l1.end(), l2.end(), [leftOffset, C])

    const o = offset(15)
    line(l1.start(), o.start())
    line(l2.start(), o.end())
});

const support = extrude(95)

// Pipe 1 — front
const p1 = plane("front", 10);

sketch(p1, () => {
    move([leftOffset, 95]);
    hMove(7.5)
    circle(X)
});

const cylBody1 = extrude(-D)
circle(E, cylBody1.startFaces())
const cylCut1 = cut()

chamfer(2, cylCut1.startEdges(), cylCut1.endEdges())

// Pipe 2 — right
const p2 = plane("right", B + 10)

sketch(p2, () => {
    move([C - 7.5, 95]);
    circle(Y)
});

const cylBody2 = extrude(-D)
circle(E, cylBody2.startFaces())
const cylCut2 = cut()

chamfer(2, cylCut2.startEdges(), cylCut2.endEdges())

// Corner block
sketch("xy", () => {
    move([B, 0])
    rect(-60, 60).radius(10, 0, 15, 0);
});

const corner = extrude(35);

// Through-all hole
circle(15, corner.endFaces())
cut()

// Counterbore
circle(30, corner.endFaces())
cut(10)

// Face pocket
const topFace = select(face().onPlane("xy", 25).hasEdge(edge().line(45)));

sketch(base.endFaces(), () => {
    project(topFace);
    offset(-9, true)
});

const c = cut(20)

fillet(10, c.internalEdges())
