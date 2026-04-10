import { sketch } from 'fluidcad/core';
import { move, arc, slot } from 'fluidcad/core';

sketch("xy", () => {
    move([100, 0])
    const a = arc(90, 0, 90)
    slot(a, 20, true)
})
