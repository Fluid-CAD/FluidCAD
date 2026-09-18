import { assembly, insert, mate } from "fluidcad/core";
import { frame } from "./frame.part.js";
import { wheel } from "./wheel.part.js";
import { arm } from "./arm.part.js";
import { link } from "./link.part.js";
import { pin } from "./pin.part.js";
import { ram } from "./ram.part.js";
import { guide } from "./guide.part.js";
import { bolt } from "./bolt.part.js";
import { D } from "./dimensions.js";

// Seed the same branch that the physical mates will solve. This only sets the
// starting pose; animation is driven entirely by the named crank revolute mate.
function startingPose() {
  const px = D.crankX + D.crankRadius;
  const py = D.crankY;
  const lowerPoint = (a) => {
    const y = D.ramY - D.leverLength * Math.sin(a);
    return {x: px - (py - y) / Math.tan(a), y};
  };
  const error = (a) => {
    const p = lowerPoint(a);
    return (p.x - D.anchorX) ** 2 + (p.y - D.anchorY) ** 2 - D.linkLength ** 2;
  };
  let lo = Math.PI / 3, hi = Math.PI / 2;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (error(lo) * error(mid) <= 0) hi = mid; else lo = mid;
  }
  const theta = (lo + hi) / 2;
  const lower = lowerPoint(theta);
  return {
    lower, armAngle: theta * 180 / Math.PI,
    linkAngle: Math.atan2(lower.y - D.anchorY, lower.x - D.anchorX) * 180 / Math.PI,
    ramX: lower.x + D.leverLength * Math.cos(theta),
  };
}
function placed(instance, x, height, depth, theta = 0) {
  return instance.rotate("z", theta).rotate("x", 90).translate(x, -depth, height);
}

export const quickReturn = assembly("Quick return mechanism", () => {
  const start = startingPose();
  const stand = insert(frame).rotate("x", 90).grounded().name("Open frame");
  const crank = placed(insert(wheel), D.crankX, D.crankY, D.crankDepth).name("Crank wheel");
  const lever = placed(insert(arm), start.lower.x, start.lower.y, D.leverDepth, start.armAngle).name("Slotted arm");
  const rocker = placed(insert(link), D.anchorX, D.anchorY, D.linkDepth, start.linkAngle).name("Lower link");
  const follower = placed(insert(pin), D.crankX + D.crankRadius, D.crankY, D.crankDepth + D.crankThickness).name("Sliding crank pin");
  const carriage = placed(insert(ram), start.ramX, D.ramY, D.ramDepth).name("Ram");
  const rails = placed(insert(guide), 0, D.ramY, 0).name("Ram guide");

  const crankBolt = placed(insert(bolt), D.crankX, D.crankY, D.crankDepth + D.crankThickness + 0.5).name("Crank axle");
  const anchorBolt = placed(insert(bolt, {"Shaft length": 40}), D.anchorX, D.anchorY, D.linkDepth + D.linkThickness + 0.5).name("Lower fixed axle");
  const lowerBolt = placed(insert(bolt, {"Shaft diameter": 8, "Shaft length": 17, "Head diameter": 20}),
    start.lower.x, start.lower.y, D.linkDepth + D.linkThickness + 0.5, start.armAngle).name("Lower arm axle");
  const ramBolt = placed(insert(bolt, {"Shaft diameter": 8, "Shaft length": 24, "Head diameter": 18}),
    start.ramX, D.ramY, D.leverDepth + D.leverThickness + 0.5).name("Ram joint axle");

  mate("revolute", stand.connectors.crank, crank.connectors.axis).flip().name("crank-drive");
  mate("fastened", stand.connectors.guide, rails.connectors.mount).flip().name("guide-mount");
  mate("slider", stand.connectors.ram, carriage.connectors.slide).flip().name("ram-travel");
  mate("revolute", stand.connectors.anchor, rocker.connectors.fixed).flip().name("lower-rocker");
  mate("revolute", rocker.connectors.arm, lever.connectors.lower).flip().name("lower-arm-joint");
  mate("revolute", carriage.connectors.arm, lever.connectors.upper).flip().name("ram-arm-joint");
  mate("fastened", crank.connectors.pin, follower.connectors.seat).flip().name("crank-pin");
  mate("tangent", follower.features.tread, lever.features.slotWall).noPropagate().name("pin-in-slot");
  mate("fastened", stand.connectors.crankBolt, crankBolt.connectors.seat).flip();
  mate("fastened", stand.connectors.anchorBolt, anchorBolt.connectors.seat).flip();
  mate("fastened", lever.connectors.lowerBolt, lowerBolt.connectors.seat).flip();
  mate("fastened", carriage.connectors.bolt, ramBolt.connectors.seat).flip();
  return { stand, crank, lever, rocker, follower, carriage, rails, crankBolt, anchorBolt, lowerBolt, ramBolt };
});
