import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SceneTypes } from "../../common/scene-types.js";

const LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Every type the engine's scene objects answer, read from the source: the
 * string literals in each `getType()` body, the kinds the sketch
 * constraints are emitted with (a constraint's type is its kind), and the
 * `static id` of the engine's own custom features (`draft`).
 */
class EngineTypeScan {
  static collect(): Map<string, string> {
    const found = new Map<string, string>();
    for (const file of EngineTypeScan.sources(LIB)) {
      const code = EngineTypeScan.withoutComments(fs.readFileSync(file, "utf8"));
      const where = path.relative(LIB, file);
      for (const body of code.matchAll(/getType\(\)\s*(?::\s*string\s*)?\{([\s\S]*?)\n\s*\}/g)) {
        for (const literal of body[1].matchAll(/["'`]([^"'`]+)["'`]/g)) {
          found.set(literal[1], where);
        }
      }
      for (const pattern of [
        /emitConstraint\(\s*context,\s*["']([^"']+)["']/g,
        /twoTargetCommand\(\s*["']([^"']+)["']/g,
        /static id\s*=\s*["']([^"']+)["']/g,
      ]) {
        for (const match of code.matchAll(pattern)) {
          found.set(match[1], where);
        }
      }
    }
    return found;
  }

  private static sources(dir: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["dist", "tests", "node_modules"].includes(entry.name)) {
          files.push(...EngineTypeScan.sources(full));
        }
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        files.push(full);
      }
    }
    return files;
  }

  private static withoutComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  }
}

describe("SceneTypes", () => {
  it("lists every type an engine scene object answers", () => {
    const found = EngineTypeScan.collect();
    expect(found.size).toBeGreaterThan(60);
    const missing = [...found].filter(([type]) => !SceneTypes.isEngineType(type)).map(([type, file]) => `${type} (${file})`);
    expect(missing).toEqual([]);
  });

  it("lists nothing the engine doesn't answer, but the kinds the server reads", () => {
    const found = EngineTypeScan.collect();
    const extra = [...SceneTypes.ENGINE].filter(type => !found.has(type));
    expect(extra).toEqual(['feature']);
  });

  it("knows the types the server and the UI read specially", () => {
    for (const type of ['extrude', 'cut', 'part', 'assembly', 'part-definition', 'feature', 'draft', 'sketch']) {
      expect(SceneTypes.isEngineType(type)).toBe(true);
    }
    for (const type of ['standoff', 'boltCircle', 'acme.extrude', '@acme/kit:extrude']) {
      expect(SceneTypes.isEngineType(type)).toBe(false);
    }
  });
});
