// @screenshot showAxes
import { sketch, circle, extrude, translate, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A base plate with a stud, and a spacer that has to slide onto the stud.
sketch("xy", () => {
    const b = line([-50, -30], [50, -30]);
    const r = line([50, -30], [50, 30]);
    const t = line([50, 30], [-50, 30]);
    const l = line([-50, 30], [-50, -30]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-50, -30]);
    distance(b.start(), b.end(), 100);
    distance(r.start(), r.end(), 60);
});
const plate = extrude(8);

// The stud, on the plate's top face at x = 30.
sketch(plate.endFaces(), () => { circle([30, 0], 10); });
extrude(30);

// The spacer: a ring modelled at x = -30, a separate body.
sketch(plate.endFaces(), () => {
    circle([-30, 0], 24);
    circle([-30, 0], 10);
});
const spacer = extrude(8).new();

// highlight-start
// Slide the spacer 60 along X onto the stud. translate() has no dialog: it
// names its targets (or takes the last object) and adds a step to the timeline.
translate(60, 0, 0, spacer);
// highlight-end
