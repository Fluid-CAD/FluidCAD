// @screenshot solidsOnly
import { part, sketch, line, extrude, fillet, color, select } from 'fluidcad/core';
import { face } from 'fluidcad/filters';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A 120 × 40 × 18 board. The appearance is a chain on the part() statement
// — Set appearance… on the timeline row writes it — and the viewport draws
// the board as oak, grain running along its length.
export const board = part('Board', () => {
    sketch('xy', () => {
        const b = line([-60, -20], [60, -20]);
        const r = line([60, -20], [60, 20]);
        const t = line([60, 20], [-60, 20]);
        const l = line([-60, 20], [-60, -20]);
        coincident(b.end(), r.start());
        coincident(r.end(), t.start());
        coincident(t.end(), l.start());
        coincident(l.end(), b.start());
        horizontal(b);
        horizontal(t);
        vertical(r);
        vertical(l);
        fix(b.start(), [-60, -20]);
        distance(b.start(), b.end(), 120);
        distance(r.start(), r.end(), 40);
    });
    const e = extrude(18);
    fillet(3, e.endEdges());
    // Paint is the override: the end face keeps its flat colour over the oak.
    select(face().onPlane('yz', 60));
    color('tomato');
// highlight-next-line
}).appearance('oak');

// A 40 × 40 × 30 block beside it, drawn as polished steel.
export const block = part('Block', () => {
    sketch('xy', () => {
        const b = line([80, -20], [120, -20]);
        const r = line([120, -20], [120, 20]);
        const t = line([120, 20], [80, 20]);
        const l = line([80, 20], [80, -20]);
        coincident(b.end(), r.start());
        coincident(r.end(), t.start());
        coincident(t.end(), l.start());
        coincident(l.end(), b.start());
        horizontal(b);
        horizontal(t);
        vertical(r);
        vertical(l);
        fix(b.start(), [80, -20]);
        distance(b.start(), b.end(), 40);
        distance(r.start(), r.end(), 40);
    });
    const e = extrude(30);
    fillet(4, e.endEdges());
// highlight-next-line
}).appearance('steel');
