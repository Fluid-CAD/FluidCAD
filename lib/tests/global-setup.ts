import { beforeAll } from "vitest";
import { init } from "../index.js";

beforeAll(async () => {
  process.env.FLUIDCAD_WORKSPACE_PATH = "/tmp/fluidcad-test";
  await init();
});
