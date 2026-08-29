import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    server: {
      deps: {
        // When ocjs-fluidcad is npm-linked it resolves outside node_modules,
        // so vite would transform the emscripten loader — rewriting its
        // `new URL(..., import.meta.url)` wasm lookup into an http URL under
        // the jsdom environment. Keep it external either way; matching runs
        // on the RESOLVED path, so name the link target too.
        external: [/ocjs-fluidcad/, /ocjsv8[\\/]opencascade\.js/],
      },
    },
    include: [
      "lib/**/*.test.ts",
      "server/tests/**/*.test.ts",
      "mcp/tests/**/*.test.ts",
      "ui/tests/**/*.test.ts",
      "scripts/tests/**/*.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    isolate: false,
    setupFiles: ["lib/tests/global-setup.ts"],
  },
});
