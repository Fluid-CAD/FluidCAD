import { PMREMGenerator, Scene, type Texture, type WebGLRenderer } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * The reflection environment the appearance materials (PBR, see
 * appearance-material.ts) shade against: a pre-filtered render of three's
 * RoomEnvironment — a neutral studio of area lights, generated on the GPU,
 * no image shipped. The default Phong faces ignore `scene.environment`, so
 * installing it changes nothing about how a plain or `color()`-painted model
 * looks.
 *
 * A PMREM texture lives in the GL context that generated it, so it is kept
 * per renderer: the viewport's, the Insert dialog's thumbnail renderer, and
 * a screenshot's throwaway renderer each get their own and dispose it with
 * the renderer.
 */
const environments = new WeakMap<WebGLRenderer, Texture>();

/** The environment texture for `renderer`, generated on first use. */
export function environmentFor(renderer: WebGLRenderer): Texture {
  let texture = environments.get(renderer);
  if (!texture) {
    const generator = new PMREMGenerator(renderer);
    texture = generator.fromScene(new RoomEnvironment(), 0.04).texture;
    generator.dispose();
    environments.set(renderer, texture);
  }
  return texture;
}

/** Free `renderer`'s environment texture (before the renderer itself goes). */
export function disposeEnvironmentOf(renderer: WebGLRenderer): void {
  environments.get(renderer)?.dispose();
  environments.delete(renderer);
}

/** Whether anything in `scene` shades against the environment — an appearance material. */
export function sceneUsesEnvironment(scene: Scene): boolean {
  let found = false;
  scene.traverse((object) => {
    if (found) {
      return;
    }
    const material = (object as { material?: { userData?: { appearance?: unknown } } }).material;
    if (material && typeof material.userData?.appearance === 'string') {
      found = true;
    }
  });
  return found;
}
