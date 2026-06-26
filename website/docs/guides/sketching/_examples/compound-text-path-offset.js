// @screenshot waitForInput
import { arc, extrude, sketch, text } from 'fluidcad/core';

const path = sketch("xy", () => {
  arc([0, 0], [100, 0]).center([50, -120]).cw();
});
const above = text("FLOATING ABOVE", path).size(8).align("center").offset(10);
const below = text("TUCKED BELOW", path).size(8).align("center").offset(-14);
extrude(3, above);
extrude(3, below);
