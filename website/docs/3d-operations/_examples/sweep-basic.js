import { sketch, sweep } from 'fluidcad/core';
import { circle, line, arc } from 'fluidcad/core';
import { coincident, vertical, tangent, radius, fix } from 'fluidcad/constraints';

// The profile: a ring (two concentric circles — the inner one is a hole),
// drawn on the top plane at the origin, where the path starts.
const profile = sketch("top", () => {
    circle([0, 0], 40);
    circle([0, 0], 20);
  })

// The path: a line and two arcs on the front plane, joined end to end and
// tangent at the joints so the pipe bends without kinks.
const spine = sketch("front", () => {
    const l = line([0, 0], [0, 100]);
    const a1 = arc([0, 100], [-100, 100], [-50, 100]);
    const a2 = arc([-100, 100], [-180, 180], [-180, 100]).cw();
    // Join the segments...
    coincident(l.end(), a1.start());
    coincident(a1.end(), a2.start());
    vertical(l);
    // ...and make the bends smooth
    tangent(l, a1);
    tangent(a1, a2);
    // Pin the start at the origin (where the profile sits) and size the bends
    fix(l.start());
    radius(a1, 50);
    radius(a2, 80);
  })

// Sweep the profile along the path: path first, profile second.
sweep(spine, profile)
