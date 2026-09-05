// @screenshot size 4800x3200 crop 0,0,100,38
import { arc, sketch, text } from 'fluidcad/core';

sketch("xy", () => {
  // The path is a guide arc: it shapes the text but never joins the profile.
  const path = arc([0, 0], [100, 0], [50, -120]).cw().guide();
  // Positive offset floats the baseline above the curve, negative tucks it below.
  text("FLOATING ABOVE", path).size(8).align("center").offset(10);
  text("TUCKED BELOW", path).size(8).align("center").offset(-14);
});
