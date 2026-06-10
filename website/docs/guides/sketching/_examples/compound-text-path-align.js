// @screenshot waitForInput
import { arc, extrude, sketch, text } from 'fluidcad/core';

sketch("xy", () => {
  const aligns = ["start", "center", "end", "stretch"];
  aligns.forEach((align, i) => {
    const y = -i * 24;
    const path = arc([0, y], [100, y]).center([50, y - 120]).cw().guide();
    text(align, path).size(9).align(align);
  });
});
extrude(3);
