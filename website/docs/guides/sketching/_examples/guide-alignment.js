import { sketch, move } from 'fluidcad/core';
import { circle } from 'fluidcad/core';

sketch("xy", () => {
    circle(80).guide()

    move([40, 0])
    circle(15)

    move([-40, 40])
    circle(15)

    move([-40, -40])
    circle(15)
})
