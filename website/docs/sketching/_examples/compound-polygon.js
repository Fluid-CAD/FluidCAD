import { sketch, line, circle, origin } from 'fluidcad/core';
import { coincident, equal, tangent, angle, diameter, horizontal } from 'fluidcad/constraints';

sketch("xy", () => {
    // A circumscribed hexagon: the centre clicked on the origin, 60 typed
    // for the diameter, 6 for the sides. One line per side, corner to
    // corner, and a guide circle the sides are tangent to.
    const l1 = line([34.64, 0], [17.32, 30]);
    const l2 = line([17.32, 30], [-17.32, 30]);
    const l3 = line([-17.32, 30], [-34.64, 0]);
    const l4 = line([-34.64, 0], [-17.32, -30]);
    const l5 = line([-17.32, -30], [17.32, -30]);
    const l6 = line([17.32, -30], [34.64, 0]);
    const c1 = circle([0, 0], 60).guide();
    coincident(l1.end(), l2.start());
    coincident(l2.end(), l3.start());
    coincident(l3.end(), l4.start());
    coincident(l4.end(), l5.start());
    coincident(l5.end(), l6.start());
    coincident(l6.end(), l1.start());
    // Regular: equal sides, every side tangent to the guide circle. With
    // an even number of sides the last side is left out of the equal (the
    // tangents already force it) and one corner angle pins the shape.
    equal(l1, l2, l3, l4, l5);
    tangent(l1, c1);
    tangent(l2, c1);
    tangent(l3, c1);
    tangent(l4, c1);
    tangent(l5, c1);
    tangent(l6, c1);
    angle(l1, l2, 60);
    // Circumscribed: the typed diameter is the guide circle's, measured
    // across the flats. Resize the polygon by changing this one value.
    diameter(c1, 60);
    // The centre click snapped onto the origin.
    coincident(c1.center(), origin());
    // The tool leaves one degree of freedom: the polygon can spin about its
    // centre. Horizontal on one side settles it.
    // highlight-next-line
    horizontal(l2);
})
