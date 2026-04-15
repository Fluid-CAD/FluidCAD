import { sketch, offset } from 'fluidcad/core';
import { rect } from 'fluidcad/core';

sketch("xy", () => {
    rect(100, 60).centered()
    offset(-10, true)
})
