// @screenshot size 2400x1600
import { arc, sketch, text } from 'fluidcad/core';

sketch("xy", () => {
  const path = arc([0, 0], [180, 0]).center([90, -216]).cw().guide();
  text("start", path).size(14).align("start");
});
