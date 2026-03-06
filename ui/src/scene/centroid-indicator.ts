import { Mesh, MeshBasicMaterial, Scene, SphereGeometry } from 'three';

export class CentroidIndicator {
  private mesh: Mesh | null = null;

  show(scene: Scene, pos: { x: number; y: number; z: number }, radius: number): void {
    this.clear(scene);
    const geo = new SphereGeometry(radius, 16, 16);
    const mat = new MeshBasicMaterial({ color: 0xff4400, depthTest: false });
    const mesh = new Mesh(geo, mat);
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.renderOrder = 999;
    mesh.userData.isMetaShape = true;
    scene.add(mesh);
    this.mesh = mesh;
  }

  clear(scene: Scene): void {
    if (!this.mesh) { return; }
    (this.mesh.geometry as SphereGeometry).dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
    scene.remove(this.mesh);
    this.mesh = null;
  }
}
