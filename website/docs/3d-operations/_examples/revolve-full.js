// @screenshot showAxes
import { sketch, revolve } from 'fluidcad/core';
import { circle } from 'fluidcad/core';

sketch("xz", () => {
    circle([80, 0], 40)
})

// No angle: a full 360° turn around Z.
revolve("z")
