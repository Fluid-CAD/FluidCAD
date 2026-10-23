import { afterEach, beforeAll, beforeEach } from "vitest";
import path from "node:path";
import { init } from "../index.js";
import { getSceneManager } from "../scene-manager.js";
import type { Scene } from "../rendering/scene.js";

beforeAll(async () => {
  process.env.FLUIDCAD_WORKSPACE_PATH = "/tmp/fluidcad-test";
  await init();
});

// Every scene a test starts is released when the test ends. startScene()
// replaces the manager's current scene without disposing it (the browser
// host frees a replaced scene itself after the compare), so the suite
// otherwise keeps every test's kernel shapes until the wasm heap's 4 GiB
// ceiling, after which the kernel corrupts. Scenes started outside a test
// (beforeAll fixtures) are left alone. All of a test's scenes go in one pass
// because a compare shares raw handles between them.
//
// The host tests drive the real BrowserEngineHost, which keeps its previous
// scene across tests to compare the next render against and disposes it
// itself; releasing those here would free shapes still in use.
const KEEPS_SCENES_ACROSS_TESTS = new Set([
  "browser-host.test.ts",
  "browser-host-materials.test.ts",
  "browser-host-unit.test.ts",
]);

let startedInTest: Scene[] | null = null;
// The host's init() replaces the global manager: follow whichever is current.
let subscribedTo: ReturnType<typeof getSceneManager> = undefined;

beforeEach((ctx) => {
  const manager = getSceneManager();
  if (manager && manager !== subscribedTo) {
    manager.onSceneStarted((scene) => { startedInTest?.push(scene); });
    subscribedTo = manager;
  }
  const file = path.basename(ctx.task.file?.filepath ?? "");
  startedInTest = KEEPS_SCENES_ACROSS_TESTS.has(file) ? null : [];
});

afterEach(() => {
  const scenes = startedInTest;
  startedInTest = null;
  if (scenes && scenes.length > 0) {
    getSceneManager()?.disposeScenes(scenes);
  }
});
