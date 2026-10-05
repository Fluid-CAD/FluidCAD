// @screenshot view iso-ftr
import { arc, extrude, sketch, text } from 'fluidcad/core';

sketch("xy", () => {
  const path = arc([0, 0], [100, 0], [50, -120]).cw().guide();
  const t1 = text("CURVED TEXT", path).size(12).align("center");
});
extrude(4);
