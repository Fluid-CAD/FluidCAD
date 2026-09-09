// @screenshot showAxes
import { sketch, circle, origin } from 'fluidcad/core';
import { diameter, distance, horizontal } from "fluidcad/constraints";

// The profile, on the front (xz) plane — the plane that contains the Z axis
// the revolve turns around. The 80 mm from the origin is what keeps the
// profile off the axis, so it sweeps a ring rather than a ball.
sketch("xz", () => {
    const c = circle([80, 0], 40);
    horizontal(origin(), c.center());
    distance(origin(), c.center(), 80);
    diameter(c, 40);
  })
