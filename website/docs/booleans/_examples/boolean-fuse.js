import { sketch, circle, extrude, fuse, cut, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A mounting plate and a boss that were modelled as separate bodies.
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

// The boss stands on the plate but .new() keeps it its own solid.
sketch(plate.endFaces(), () => { circle([0, 0], 30); });
const boss = extrude(25).new();

// highlight-start
// The Boolean dialog's Fuse tab with the plate and the boss in the Solids
// slot: one body out, the shared face merged away. Colours follow the FIRST
// input — the plate here.
fuse(plate, boss);
// highlight-end

// The bore goes through the fused body as one cut. The boss's top face is
// still a valid sketch plane after the fuse consumed the boss.
sketch(boss.endFaces(), () => { circle([0, 0], 12); });
cut();
