// @screenshot size 4800x3200 crop 0,0,100,16
import { arc, sketch, text } from 'fluidcad/core';

sketch("xy", () => {
  const path = arc([0, 0], [180, 0], [90, -216]).cw().guide();
  text("space-around", path).size(14).align("space-around");
});
