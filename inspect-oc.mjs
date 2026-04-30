import initOpenCascade from "occjs-wrapper/node/multi-threaded";

const oc = await initOpenCascade();

console.log("Geom_CylindricalSurface:", typeof oc.Geom_CylindricalSurface);
console.log("Handle_Geom2d_Curve:", typeof oc.Handle_Geom2d_Curve);
console.log("Geom2d_Line:", typeof oc.Geom2d_Line);
console.log("gp_Lin2d:", typeof oc.gp_Lin2d);

try {
  const p1 = new oc.gp_Pnt2d(0, 0);
  const dir = new oc.gp_Dir2d(1, 0);
  console.log("Pnt2d/Dir2d created OK");
  
  const lin2d = new oc.gp_Lin2d(p1, dir);
  console.log("gp_Lin2d created OK");
} catch (e) {
  console.log("ERR1:", e.message);
}

try {
  const p1 = new oc.gp_Pnt2d(0, 0);
  const dir = new oc.gp_Dir2d(1, 0);
  const lin2d = new oc.gp_Lin2d(p1, dir);
  const line2d = new oc.Geom2d_Line(lin2d);
  console.log("Geom2d_Line(gp_Lin2d) created OK");
} catch (e) {
  console.log("ERR2:", e.message);
}

try {
  const p1 = new oc.gp_Pnt2d(0, 0);
  const dir = new oc.gp_Dir2d(1, 0);
  const line2d_alt = new oc.Geom2d_Line(p1, dir);
  console.log("Geom2d_Line(p,dir) created OK");
} catch (e) {
  console.log("ERR3:", e.message);
}

try {
  const p1 = new oc.gp_Pnt2d(0, 0);
  const dir = new oc.gp_Dir2d(1, 0);
  const lin2d = new oc.gp_Lin2d(p1, dir);
  const line2d = new oc.Geom2d_Line(lin2d);
  const handle = new oc.Handle_Geom2d_Curve(line2d);
  console.log("Handle_Geom2d_Curve(Geom2d_Line) created OK");
} catch (e) {
  console.log("ERR4:", e.message);
}
