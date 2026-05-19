import { sketch, arc, tLine } from 'fluidcad/core';

sketch("xy", () => {
    arc([60, 60]).center([0, 60])   // quarter arc — pen ends at (60, 60), heading +Y
    tLine(80)                        // continues 80 units in that tangent direction
})
