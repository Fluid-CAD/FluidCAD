// @screenshot showAxes
import { sketch, circle, extrude, plane, cut, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A shaft clamp: a block with a bore, sawn into two halves at its mid-height
// so the halves can be bolted around a shaft.
sketch("xy", () => {
    const b = line([-30, -20], [30, -20]);
    const r = line([30, -20], [30, 20]);
    const t = line([30, 20], [-30, 20]);
    const l = line([-30, 20], [-30, -20]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-30, -20]);
    distance(b.start(), b.end(), 60);
    distance(r.start(), r.end(), 40);
});
const block = extrude(40);

// The bore for the shaft, through the block along X at mid-height.
sketch("yz", () => { circle([0, 20], 20); });
cut(35).symmetric();

// highlight-start
// The split plane: halfway between the block's bottom and top faces — the
// Plane dialog's Mid plane type with the two faces as Bases. It tracks the
// block: make the block taller and the split stays centred on the bore.
const split = plane(plane(block.startFaces()), plane(block.endFaces()));
// highlight-end

// A saw cut 2 wide on the split plane, symmetric about it, leaves two halves.
sketch(split, () => {
    const b = line([-40, -30], [40, -30]);
    const r = line([40, -30], [40, 30]);
    const t = line([40, 30], [-40, 30]);
    const l = line([-40, 30], [-40, -30]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-40, -30]);
    distance(b.start(), b.end(), 80);
    distance(r.start(), r.end(), 60);
});
cut(1).symmetric();
