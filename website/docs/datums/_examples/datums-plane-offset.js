// @screenshot showAxes framePlanes view iso-ftr
import { plane } from 'fluidcad/core';

// highlight-start
// The ground plane lifted 40 along its normal — the Plane dialog's Offset
// type with the XY origin quad as Base and a Distance of 40. The quad in the
// viewport is the plane; the arrow at its centre shows which way it faces.
const top = plane("xy", 40);
// highlight-end
