// ASSUMPTION: the user's undimensioned image is a visual reference.
// Nominal mm at a 280 mm frame height; no production fit or load rating is implied.
// Parts use XY as the mechanism plane; the assembly turns it upright into world XZ.
export const D = {
  frameWidth: 230, frameHeight: 280, panelDepth: 8, footWidth: 270, footDepth: 88,
  footBack: -24, footHeight: 8, cornerRadius: 10,
  crankX: -20, crankY: 175, crankRadius: 40, crankDiameter: 116,
  crankDepth: 22, crankThickness: 8, crankBossDiameter: 36,
  anchorX: 55, anchorY: 42, linkLength: 65, linkDepth: 44, linkThickness: 6,
  leverLength: 260, leverRadius: 13, leverDepth: 34, leverThickness: 8,
  slotStart: 45, slotEnd: 225, slotWidth: 16,
  pivotDiameter: 12, pivotClearance: 12.4, jointDiameter: 8, jointClearance: 8.4,
  ramY: 290, ramDepth: 18, ramThickness: 14, ramLength: 340, ramLeft: -125,
  ramHalfHeight: 10, guideHalfLength: 145, guideRear: 16, guideFront: 34,
  guideFloorHeight: 5, guideLipHeight: 6, edgeBreak: 0.8,
  frameColor: "#899a96", wheelColor: "#c9d4d1", leverColor: "#a7beb6",
  linkColor: "#c4bbb0", ramColor: "#d6c7b3", guideColor: "#b0beba", pinColor: "#e0d8cc",
};
