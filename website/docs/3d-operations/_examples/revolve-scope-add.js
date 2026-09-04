// @screenshot view iso-ftr
import { sketch, revolve, circle, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

// The base part every column shares: a flanged bushing, itself a revolve.
// The profile is the bushing's half cross-section on the front plane:
// bore radius 10, body radius 20 and 25 tall, flange radius 30 and 5 thick.
sketch("xz", () => {
    const b1 = line([10, 0], [20, 0]);
    const b2 = line([20, 0], [20, 25]);
    const b3 = line([20, 25], [30, 25]);
    const b4 = line([30, 25], [30, 30]);
    const b5 = line([30, 30], [10, 30]);
    const b6 = line([10, 30], [10, 0]);
    coincident(b1.end(), b2.start());
    coincident(b2.end(), b3.start());
    coincident(b3.end(), b4.start());
    coincident(b4.end(), b5.start());
    coincident(b5.end(), b6.start());
    coincident(b6.end(), b1.start());
    horizontal(b1);
    vertical(b2);
    horizontal(b3);
    vertical(b4);
    horizontal(b5);
    vertical(b6);
    fix(b1.start(), [10, 0]);
    distance(b1.start(), b1.end(), 10);
    distance(b2.start(), b2.end(), 25);
    distance(b3.start(), b3.end(), 10);
    distance(b4.start(), b4.end(), 5);
  })
const bushing = revolve("z")

// The feature profile: a Ø6 circle centred on the bushing's outer surface,
// halfway up the body — the cross-section of an O-ring.
sketch("xz", () => {
    circle([20, 12], 6);
  })

// Add tab: the ring fuses with the bushing — a raised half-round bead.
// highlight-next-line
revolve("z")
