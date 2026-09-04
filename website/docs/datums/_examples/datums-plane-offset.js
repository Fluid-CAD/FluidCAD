// @screenshot showAxes
import { sketch, circle, extrude, plane, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A two-tier shelf: the lower plate on the ground, a post, and an upper plate
// that has to sit exactly 40 above the lower one.
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
const lower = extrude(6);

// The post rises 40 from the lower plate's top face.
sketch(lower.endFaces(), () => { circle([-35, 0], 12); });
extrude(40);

// highlight-start
// The upper plate's plane: the lower plate's top face lifted 40 along its
// normal — the Plane dialog's Offset type with that face as Base and a
// Distance of 40. Change the post height and the plane moves with it only if
// you change this number too; both read the same 40.
const upperLevel = plane(lower.endFaces(), 40);
// highlight-end

// A plane is a sketch target like any face: the upper plate is drawn on it and
// extruded 6 up. It touches the post, so the three fuse into one shelf.
sketch(upperLevel, () => {
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
extrude(6);
