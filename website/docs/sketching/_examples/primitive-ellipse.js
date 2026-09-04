import { sketch, ellipse, circle, origin } from 'fluidcad/core';
import { coincident, diameter } from 'fluidcad/constraints';

sketch("xy", () => {
    // An elliptical cam with its shaft bore.
    // ellipse(center, rx, ry): semi-radii along the plane's X and Y axes.
    // The centre is a solver point; the radii are fixed literals.
    const cam = ellipse([0, 0], 50, 30);
    // Pin the centre on the sketch origin — the only accessor an ellipse has.
    coincident(cam.center(), origin());
    // The shaft bore, offset from the cam's centre so the lobe leads.
    const bore = circle([-15, 0], 12);
    diameter(bore, 12);
})
