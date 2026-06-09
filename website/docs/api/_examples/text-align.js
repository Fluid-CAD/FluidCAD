// @screenshot waitForInput
import { text, extrude } from 'fluidcad/core';

text("xy", "Multi\nLine").size(12).align("center")
extrude(4)
