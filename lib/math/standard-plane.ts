// The names of the six standard planes, each under its axis name and its
// view name. A module of its own, with no imports: the drawing model names a
// standard plane by this type, and the editor reads the drawing model in the
// page, where the rest of the plane math (and the kernel behind it) is not.

export type StandardPlane =
  | "xy"
  | "xz"
  | "yz"
  | "-xy"
  | "-xz"
  | "-yz"
  | "top"
  | "bottom"
  | "front"
  | "back"
  | "left"
  | "right";
