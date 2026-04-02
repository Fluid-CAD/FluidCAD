import { beforeAll } from "vitest";
import { init } from "../index.js";

beforeAll(async () => {
  await init("/tmp/fluidcad-test");
});
