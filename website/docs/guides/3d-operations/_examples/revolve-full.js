// @screenshot showAxes
import { sketch, revolve } from 'fluidcad/core';
import { circle } from 'fluidcad/core';

sketch("xz", () => {
    circle([80, 0], 40)
})

revolve("z")
