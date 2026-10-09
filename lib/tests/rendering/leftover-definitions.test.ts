import { describe, it, expect, afterEach } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import * as core from "../../core/index.js";
import part from "../../core/part.js";
import cylinder from "../../core/cylinder.js";
import { Scene } from "../../rendering/scene.js";
import { Part } from "../../features/part.js";
import type { PartDefinition } from "../../features/part-definition.js";

// A part-kind render builds the leftover definitions (no variant yet) its
// ENTRY file declares, never the ones another module declares — an imported
// `.part.js`, the parts a package's index re-exports. `part()` records its
// file through the stack trace, which only recognises fluid script
// suffixes, so each "file" here is a snippet run under a sourceURL — the
// trick fixtures/inch-part.ts uses.

const ENTRY = "/ws/mount.part.js";
const OTHER = "/ws/bracket.part.js";

/**
 * Run `body` as the module `sourceURL` with the core API in scope (plus
 * `extra`), returning what it returns.
 */
function runAs(sourceURL: string, body: string, extra: Record<string, unknown> = {}): unknown {
  const globals: Record<string, unknown> = { ...core, ...extra };
  const names = Object.keys(globals);
  const fn = new Function(...names, `"use strict";\n${body}\n//# sourceURL=${sourceURL}`);
  return fn(...names.map(n => globals[n]));
}

/** A part named `name` declared at `sourceURL`: one cylinder. */
function declareIn(sourceURL: string, name: string): PartDefinition {
  return runAs(sourceURL, `return part(${JSON.stringify(name)}, () => { cylinder(5, 10); });`) as PartDefinition;
}

/** A part scene rendered from `entry`. */
function startPartScene(entry: string): Scene {
  const scene = getSceneManager().startScene();
  getSceneManager().setCurrentFile(entry);
  return scene;
}

/** The part names the render built, every object without a build error. */
function builtParts(scene: Scene): string[] {
  for (const obj of scene.getAllSceneObjects()) {
    expect(obj.getError()).toBeNull();
  }
  return scene.getAllSceneObjects()
    .filter((o): o is Part => o instanceof Part)
    .map(p => p.partName)
    .sort();
}

describe("leftover part definitions", () => {
  setupOC();

  afterEach(() => {
    getSceneManager().setCurrentFile("");
  });

  it("a part file declaring two parts renders both", () => {
    const scene = startPartScene(ENTRY);
    declareIn(ENTRY, "Base");
    declareIn(ENTRY, "Cap");
    render();

    expect(builtParts(scene)).toEqual(["Base", "Cap"]);
  });

  it("an entry importing another part file builds only its own parts", () => {
    const scene = startPartScene(ENTRY);
    declareIn(OTHER, "Bracket");
    declareIn(ENTRY, "Base");
    render();

    expect(builtParts(scene)).toEqual(["Base"]);
  });

  it("an imported part another module reads still builds — through the read, not the pass", () => {
    const scene = startPartScene(ENTRY);
    const bracket = declareIn(OTHER, "Bracket");
    runAs(ENTRY, "bracket.materialize();", { bracket });
    render();

    expect(builtParts(scene)).toEqual(["Bracket"]);
  });

  it("a part() reached through a helper the entry calls is the entry's", () => {
    const scene = startPartScene(ENTRY);
    // The helper module is plain JS — not a script file — so the capture
    // passes over its frame to the entry's call.
    const makeBracket = runAs("/ws/helpers.js", `return () => part('Bracket', () => { cylinder(5, 10); });`);
    runAs(ENTRY, "makeBracket();", { makeBracket });
    render();

    expect(builtParts(scene)).toEqual(["Bracket"]);
  });

  it("matches a live editor buffer against its file", () => {
    const scene = startPartScene(`virtual:live-render:${ENTRY}`);
    declareIn(`virtual:live-render:${ENTRY}`, "Base");
    declareIn(`virtual:live-render:${OTHER}`, "Bracket");
    render();

    expect(builtParts(scene)).toEqual(["Base"]);
  });

  it("matches macOS's /private/var spelling against /var, either way round", () => {
    const tmpEntry = "/var/folders/ab/T/ws/mount.part.js";
    const scene = startPartScene(tmpEntry);
    declareIn(`/private${tmpEntry}`, "Base");
    declareIn("/private/var/folders/ab/T/ws/bracket.part.js", "Bracket");
    render();
    expect(builtParts(scene)).toEqual(["Base"]);

    const again = startPartScene(`/private${tmpEntry}`);
    declareIn(tmpEntry, "Base");
    render();
    expect(builtParts(again)).toEqual(["Base"]);
  });

  it("matches Windows separators and drive letters", () => {
    const scene = startPartScene("c:\\ws\\mount.part.js");
    declareIn("C:/ws/mount.part.js", "Base");
    declareIn("C:/ws/bracket.part.js", "Bracket");
    render();

    expect(builtParts(scene)).toEqual(["Base"]);
  });

  it("builds a definition whose capture found no script frame", () => {
    const scene = startPartScene(ENTRY);
    // Called from this test module: no fluid script frame, no location.
    const def = part("Located nowhere", () => {
      cylinder(5, 10);
    });
    expect(def.getSourceLocation()).toBeNull();
    render();

    expect(builtParts(scene)).toEqual(["Located nowhere"]);
  });

  it("builds every definition when the scene has no entry file", () => {
    const scene = startPartScene("");
    declareIn(OTHER, "Bracket");
    declareIn(ENTRY, "Base");
    render();

    expect(builtParts(scene)).toEqual(["Base", "Bracket"]);
  });
});
