import { sketch, circle, origin } from 'fluidcad/core';
import { coincident, diameter, equal } from "fluidcad/constraints";

// A three-bolt flange: the holes sit on a guide pitch circle.
sketch("xy", () => {
    const rim = circle([0, 0], 110);
    const bore = circle([0, 0], 36);
    coincident(rim.center(), origin());
    coincident(bore.center(), origin());
    diameter(rim, 110);
    diameter(bore, 36);
    // The pitch circle is a guide: visible for layout, excluded from the profile.
    const pitch = circle([0, 0], 80).guide();
    coincident(pitch.center(), origin());
    diameter(pitch, 80);
    // Three bolt holes, each centred on the pitch circle.
    const h1 = circle([40, 0], 12);
    const h2 = circle([-20, 35], 12);
    const h3 = circle([-20, -35], 12);
    coincident(h1.center(), pitch);
    coincident(h2.center(), pitch);
    coincident(h3.center(), pitch);
    diameter(h1, 12);
    equal(h1, h2);
    equal(h1, h3);
})
