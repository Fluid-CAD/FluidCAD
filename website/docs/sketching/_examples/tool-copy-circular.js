import { sketch, circle, copy, extrude, origin } from 'fluidcad/core';
import { coincident, diameter, distance } from 'fluidcad/constraints';

// A flange with a six-bolt pattern.
sketch("xy", () => {
    const rim = circle([0, 0], 120);
    const bore = circle([0, 0], 40);
    coincident(rim.center(), origin());
    coincident(bore.center(), origin());
    diameter(rim, 120);
    diameter(bore, 40);
    // One bolt hole on the pitch circle (radius 45).
    const bolt = circle([45, 0], 10);
    diameter(bolt, 10);
    distance(bolt.center(), origin(), 45);
    // Six holes around a 2D centre point — not an axis, as in 3D.
    // highlight-next-line
    copy("circular", [0, 0], { count: 6, angle: 360 }, bolt)
})

extrude(8)
