// @screenshot view iso-ftr
import { sketch, text, extrude } from 'fluidcad/core';

sketch("xy", () => text("FluidCAD").size(20))
extrude(6)
