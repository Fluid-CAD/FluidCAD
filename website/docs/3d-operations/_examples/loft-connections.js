import { sketch, plane, line, arc, loft } from 'fluidcad/core';
import { fix, radius } from 'fluidcad/constraints';

const squareWidth = 80;
const roundRadius = 30;
const transitionLength = 100;
const twistDegrees = 20;
const halfWidth = squareWidth / 2;

const square = sketch('xy', () => {
  const bottom = line([-halfWidth, -halfWidth], [halfWidth, -halfWidth]);
  const right = line([halfWidth, -halfWidth], [halfWidth, halfWidth]);
  const top = line([halfWidth, halfWidth], [-halfWidth, halfWidth]);
  const left = line([-halfWidth, halfWidth], [-halfWidth, -halfWidth]);
  // The named dimensions above drive these fixed endpoints.
  for (const side of [bottom, right, top, left]) {
    fix(side.start());
    fix(side.end());
  }
  return { bottom, right, top, left };
});

const round = sketch(plane('xy', { offset: transitionLength }), () => {
  const corners = [-135, -45, 45, 135].map(degrees => {
    const angle = (degrees + twistDegrees) * Math.PI / 180;
    return [roundRadius * Math.cos(angle), roundRadius * Math.sin(angle)];
  });
  // Four arcs give the round end four real junction vertices.
  const bottom = arc(corners[0], corners[1], [0, 0]);
  const right = arc(corners[1], corners[2], [0, 0]);
  const top = arc(corners[2], corners[3], [0, 0]);
  const left = arc(corners[3], corners[0], [0, 0]);
  for (const side of [bottom, right, top, left]) {
    fix(side.start());
    fix(side.end());
    radius(side, roundRadius);
  }
  return { bottom, right, top, left };
});

// The outer solid of a square-to-round duct transition.
loft(square, round)
  // highlight-start
  .connect(square.geometries.bottom.start(), round.geometries.bottom.start())
  .connect(square.geometries.right.start(), round.geometries.right.start())
  .connect(square.geometries.top.start(), round.geometries.top.start())
  .connect(square.geometries.left.start(), round.geometries.left.start());
  // highlight-end
