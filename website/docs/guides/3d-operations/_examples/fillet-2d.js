import { sketch, fillet } from 'fluidcad/core';
import { polygon } from 'fluidcad/core';

sketch("xy", () => {
    polygon(5, 100)
    fillet(10)
})
