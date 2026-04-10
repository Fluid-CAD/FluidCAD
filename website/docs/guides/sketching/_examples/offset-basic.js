import { sketch, offset } from 'fluidcad/core';
import { rect } from 'fluidcad/core';

sketch("xy", () => {
    rect(50)
    offset(5)
})
