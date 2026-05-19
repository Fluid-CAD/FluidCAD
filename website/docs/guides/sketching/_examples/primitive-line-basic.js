import { sketch, line } from 'fluidcad/core';

sketch("xy", () => {
    line([0, 0], [100, 0])     // explicit start and end
    line([120, 60])            // continues from [100, 0] to [120, 60]
    line([20, 80])             // and on to [20, 80]
    line([0, 0])               // back to the start, closing the loop
})
