import { part, sketch, extrude, cut, plane, color, connector } from "fluidcad/core";
import { rectangle } from "./profiles.js";
import { D } from "./dimensions.js";

// Origin lies on the ram's travel line; the channel remains fixed to the frame.
export const guide = part("Ram guide channel", () => {
  const floorBottom = -D.ramHalfHeight - D.guideFloorHeight;
  const channelDepth = D.guideFront - D.guideRear;
  sketch(plane("xy", D.guideRear), () =>
    rectangle(-D.guideHalfLength, floorBottom, D.guideHalfLength * 2, D.guideFloorHeight));
  extrude(channelDepth);
  sketch(plane("xy", D.guideRear), () =>
    rectangle(-D.guideHalfLength, -D.ramHalfHeight, D.guideHalfLength * 2, D.guideLipHeight));
  extrude(2);
  sketch(plane("xy", D.guideFront - 2), () =>
    rectangle(-D.guideHalfLength, -D.ramHalfHeight, D.guideHalfLength * 2, D.guideLipHeight));
  extrude(2);
  // Opening clears the ram lug over its complete stroke; the floor still supports it.
  sketch(plane("xy", D.guideFront - 2), () => rectangle(-130, -D.ramHalfHeight, 195, D.guideLipHeight));
  cut(-2);
  color(D.guideColor);
  connector("mount", plane("xy"));
});
