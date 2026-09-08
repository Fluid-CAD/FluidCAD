import { sketch, line, circle, origin } from 'fluidcad/core';
import { coincident, equal, diameter, vertical } from 'fluidcad/constraints';

sketch("xy", () => {
    // An inscribed pentagon, 50 across the corners: the vertices sit on
    // the guide circle instead of the sides touching it.
    const l1 = line([25, 0], [7.73, 23.78]);
    const l2 = line([7.73, 23.78], [-20.23, 14.69]);
    const l3 = line([-20.23, 14.69], [-20.23, -14.69]);
    const l4 = line([-20.23, -14.69], [7.73, -23.78]);
    const l5 = line([7.73, -23.78], [25, 0]);
    const c1 = circle([0, 0], 50).guide();
    coincident(l1.end(), l2.start());
    coincident(l2.end(), l3.start());
    coincident(l3.end(), l4.start());
    coincident(l4.end(), l5.start());
    coincident(l5.end(), l1.start());
    equal(l1, l2, l3, l4, l5);
    // Inscribed: every vertex is coincident with the guide circle.
    coincident(l1.start(), c1);
    coincident(l2.start(), c1);
    coincident(l3.start(), c1);
    coincident(l4.start(), c1);
    coincident(l5.start(), c1);
    diameter(c1, 50);
    coincident(c1.center(), origin());
    // Added afterwards to stop the spin.
    vertical(l3);
})
