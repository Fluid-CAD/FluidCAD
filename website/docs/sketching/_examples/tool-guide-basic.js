import { sketch, circle, line, origin } from 'fluidcad/core';
import { coincident, equal, fix, diameter } from "fluidcad/constraints";

// A hex nut outline: a hexagon laid out on a guide circle, with the bore.
sketch("xy", () => {
    // The circumscribing circle is a guide — it sizes the hexagon and
    // stays out of the profile.
    const layout = circle([0, 0], 100).guide()
    coincident(layout.center(), origin());
    diameter(layout, 100);
    const s1 = line([50, 0], [25, 43.30127]);
    const s2 = line([25, 43.30127], [-25, 43.30127]);
    const s3 = line([-25, 43.30127], [-50, 0]);
    const s4 = line([-50, 0], [-25, -43.30127]);
    const s5 = line([-25, -43.30127], [25, -43.30127]);
    const s6 = line([25, -43.30127], [50, 0]);
    coincident(s1.end(), s2.start());
    coincident(s2.end(), s3.start());
    coincident(s3.end(), s4.start());
    coincident(s4.end(), s5.start());
    coincident(s5.end(), s6.start());
    coincident(s6.end(), s1.start());
    // Every vertex rides the guide circle …
    coincident(s1.start(), layout);
    coincident(s2.start(), layout);
    coincident(s3.start(), layout);
    coincident(s4.start(), layout);
    coincident(s5.start(), layout);
    coincident(s6.start(), layout);
    // … and equal sides make it regular.
    equal(s1, s2);
    equal(s2, s3);
    equal(s3, s4);
    equal(s4, s5);
    equal(s5, s6);
    fix(s1.start(), [50, 0]);
    // The threaded bore.
    const bore = circle([0, 0], 50);
    coincident(bore.center(), origin());
    diameter(bore, 50);
})
