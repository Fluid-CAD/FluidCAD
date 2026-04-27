import { sketch, hLine, aLine, back } from 'fluidcad/core';

sketch("front", () => {
    const l1 = hLine([0, 50], 200).centered().guide()
    back(2) // back to origin
    aLine(45, l1)
});
