import { sketch, ellipse, circle, origin } from 'fluidcad/core';
import { coincident, diameter, horizontal, radius } from 'fluidcad/constraints';

sketch("xy", () => {
    // An elliptical cam with its shaft bore.
    // ellipse(center, rx, ry): semi-radii along the ellipse's own axes —
    // guesses, like the centre; the constraints below pin all of them.
    const cam = ellipse([0, 0], 50, 30);
    // Pin the centre on the sketch origin and the RX axis along X.
    coincident(cam.center(), origin());
    horizontal(cam);
    // Size the two semi-axes.
    radius(cam, 50, 'x');
    radius(cam, 30, 'y');
    // The shaft bore, offset from the cam's centre so the lobe leads.
    const bore = circle([-15, 0], 12);
    diameter(bore, 12);
})
