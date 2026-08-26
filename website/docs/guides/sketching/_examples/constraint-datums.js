import { sketch, circle, origin, xAxis, yAxis } from 'fluidcad/core';
import { coincident, symmetric, diameter, distance, equal } from "fluidcad/constraints";

sketch("xy", () => {
    const hub = circle([2, 3], 30);
    const left = circle([-42, 2], 16);
    const right = circle([38, -1], 16);
    coincident(hub.center(), origin());
    coincident(left.center(), xAxis());
    symmetric(left.center(), right.center(), yAxis());
    equal(left, right);
    diameter(hub, 30);
    diameter(left, 16);
    distance(left.center(), right.center(), 80);
})
