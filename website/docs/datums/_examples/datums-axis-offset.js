// @screenshot showAxes
import { sketch, circle, extrude, line, revolve, axis } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A crank: the main shaft turns on the world Z axis, the crank pin stands on
// the web at a throw of 25 from it.
sketch("xy", () => { circle([0, 0], 80); });
const web = extrude(10);

// The main shaft, hanging below the web on the world Z axis.
sketch("xy", () => { circle([0, 0], 20); });
extrude(-40);

// highlight-start
// The crank pin's axis: world Z shifted 25 along X — the throw. Anything
// revolved around it is centred on the pin, not on the shaft.
const pinAxis = axis("z", { offsetX: 25 });
// highlight-end

// The pin's half-profile, drawn on the front plane beside its axis: 6 wide
// (the pin radius), from the web's top face up to 40.
sketch("xz", () => {
    const b = line([25, 10], [31, 10]);
    const r = line([31, 10], [31, 40]);
    const t = line([31, 40], [25, 40]);
    const l = line([25, 40], [25, 10]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [25, 10]);
    distance(b.start(), b.end(), 6);
    distance(r.start(), r.end(), 30);
});
revolve(pinAxis);
