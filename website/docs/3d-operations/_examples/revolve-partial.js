// @screenshot showAxes
import { sketch, revolve } from 'fluidcad/core';
import { circle } from 'fluidcad/core';

// The profile lies on the front (xz) plane, which contains the Z axis.
// The circle is 80 off the axis, so the revolve makes a ring.
sketch("xz", () => {
    circle([80, 0], 40)
})

// Turn the profile 275° around the Z axis; 360 (or no angle) is a full turn.
revolve("z", 275)
