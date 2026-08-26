import { sketch, circle } from 'fluidcad/core';

sketch("xy", () => {
    circle([0, 0], 80).guide();
    circle([40, 0], 15);
    circle([-40, 40], 15);
    circle([-40, -40], 15);
})
