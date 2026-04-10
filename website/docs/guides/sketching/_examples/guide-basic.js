import { sketch } from 'fluidcad/core';
import { circle, polygon } from 'fluidcad/core';

sketch("xy", () => {
    circle(100).guide()
    polygon(6, 100)
})
