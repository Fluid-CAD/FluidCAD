import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import { join } from "path";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { FileExport } from "../../io/file-export.js";
import { FileImport, setAssetProvider } from "../../io/file-import.js";
import { FontRegistry } from "../../io/font-registry.js";
import { AssetRoots, type AssetRoot, type AssetRootSource } from "../../io/asset-roots.js";
import load from "../../core/load.js";
import { LoadFile } from "../../features/load.js";
import { Text } from "../../features/2d/text.js";
import { box, exportable, sceneSolids, volumeOf } from "./helpers.js";
import { PackageCaller } from "../helpers/asset-callers/package-caller.js";
import { twoFontFiles, type FontFile } from "../helpers/font-files.js";

// An installed package's load() and .font() read the package's own files,
// the consumer's calls read the workspace's — decided by the file that wrote
// the call, through the source a host installs. PackageCaller's file stands
// for a package file (the source maps it, and only it, to the package
// directory); this test file stands for the consumer's own code.

const PACKAGE_LABEL = "@acme/kit@1.0.0";
const PACKAGE_KEY = "packages/@acme/kit/1.0.0/";

let scratch: string;
let workspace: string;
let packageDir: string;
let previousRoot: string;
let previousSource: AssetRootSource | null = null;
/** A 10 mm box's STEP (1000 mm³) and a 20 mm box's (8000 mm³). */
let small: Uint8Array;
let large: Uint8Array;

function packageRoot(key: string | null = PACKAGE_KEY): AssetRoot {
  return { dir: packageDir, key, label: PACKAGE_LABEL };
}

/** Map PackageCaller's file to the package, everything else to nothing — as the server maps installed packages. */
function installPackageSource(key: string | null = PACKAGE_KEY): void {
  const packageFile = PackageCaller.file();
  expect(packageFile).toMatch(/asset-callers\/package-caller\.ts$/);
  AssetRoots.use((file) => (file === packageFile ? packageRoot(key) : null));
}

function stepOf(size: number): Uint8Array {
  getSceneManager().startScene();
  const solids = box(size);
  const bytes = new TextEncoder().encode(FileExport.exportShapes(exportable(solids), { format: "step" }).data as string);
  getSceneManager().startScene();
  return bytes;
}

function volumeLoadedBy(obj: unknown): number {
  render();
  const loaded = obj as LoadFile;
  expect(loaded.getError()).toBeFalsy();
  const solids = sceneSolids();
  expect(solids.length).toBe(1);
  return volumeOf(solids[0].getShape());
}

describe("AssetRoots", () => {
  setupOC();

  beforeAll(() => {
    scratch = fs.mkdtempSync(join(fs.realpathSync(os.tmpdir()), "fluidcad-asset-roots-"));
    workspace = join(scratch, "ws");
    packageDir = join(scratch, "library", "@acme", "kit", "1.0.0");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(packageDir, { recursive: true });
    small = stepOf(10);
    large = stepOf(20);
    // The same name in both: the workspace's is the small box, the package's the large one.
    FileImport.importFile(workspace, "motor.step", small);
    FileImport.importFile(packageDir, "motor.step", large);
    // Only the workspace has this one: a package must not fall back to it.
    FileImport.importFile(workspace, "mine.step", small);
  });

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  beforeEach(() => {
    previousRoot = getSceneManager().rootPath;
    getSceneManager().rootPath = workspace;
    setAssetProvider(null);
    previousSource = AssetRoots.use(null);
  });

  afterEach(() => {
    AssetRoots.use(previousSource);
    setAssetProvider(null);
    getSceneManager().rootPath = previousRoot;
  });

  describe("with no source installed", () => {
    it("reads every load() under the workspace, a package file's too, and reads no stack", () => {
      const captured: string[] = [];
      const callerFile = AssetRoots.callerFile;
      AssetRoots.callerFile = () => {
        captured.push("caller");
        return callerFile();
      };
      try {
        const loaded = PackageCaller.load("motor");
        expect(volumeLoadedBy(loaded)).toBeCloseTo(1000, 6);
      } finally {
        AssetRoots.callerFile = callerFile;
      }
      expect(captured).toEqual([]);
      expect(AssetRoots.forCall("package")).toBeNull();
    });
  });

  describe("load()", () => {
    it("reads a package file's call under the package's own imports/", () => {
      installPackageSource();
      expect(volumeLoadedBy(PackageCaller.load("motor"))).toBeCloseTo(8000, 6);
    });

    it("reads the consumer's own call under the workspace's imports/", () => {
      installPackageSource();
      expect(volumeLoadedBy(load("motor"))).toBeCloseTo(1000, 6);
    });

    it("reads the workspace's imports/ for a package file's call with { from: 'project' }", () => {
      installPackageSource();
      expect(volumeLoadedBy(PackageCaller.load("motor", { from: "project" }))).toBeCloseTo(1000, 6);
    });

    it("reads the package's for { from: 'package' }, the default stated", () => {
      installPackageSource();
      expect(volumeLoadedBy(PackageCaller.load("motor", { from: "package" }))).toBeCloseTo(8000, 6);
    });

    it("keeps a callback the consumer passes into package code the consumer's", () => {
      installPackageSource();
      const loaded = PackageCaller.run(() => load("motor"));
      expect(volumeLoadedBy(loaded)).toBeCloseTo(1000, 6);
    });

    it("fails a package's missing asset naming the package, never reading the workspace's file of that name", () => {
      installPackageSource();
      const loaded = PackageCaller.load("mine") as LoadFile;
      render();
      expect(loaded.getError()).toBe(
        "Imported asset not found: imports/mine.brep in @acme/kit@1.0.0. "
        + "If the name comes from the model using the package, read it with load(name, { from: 'project' }).",
      );
      expect(loaded.getShapes()).toEqual([]);
    });

    it("keeps the workspace's message for a missing asset outside any package", () => {
      installPackageSource();
      const loaded = load("nothing") as LoadFile;
      render();
      expect(loaded.getError()).toBe("Imported asset not found: imports/nothing.brep");
    });

    it("refuses a name that climbs out of the package", () => {
      installPackageSource();
      const loaded = PackageCaller.load("../../motor") as LoadFile;
      render();
      expect(loaded.getError()).toBe("Asset path ../motor.brep leads outside @acme/kit@1.0.0");
    });

    it("refuses a name that climbs out of the workspace", () => {
      const loaded = load("../../motor") as LoadFile;
      render();
      expect(loaded.getError()).toBe("Asset path ../motor.brep leads outside the workspace");
    });

    it("refuses a from value it does not know", () => {
      expect(() => load("motor", { from: "workspace" as never })).toThrow(
        "load(): from must be 'package' or 'project', not 'workspace'",
      );
    });

    it("notes the package's files as render inputs by their path in the package", () => {
      installPackageSource();
      PackageCaller.load("motor");
      expect(getSceneManager().getRenderInputs()).toEqual(
        ["motor.brep", "motor.colors.json", "motor.import.json"].map((name) => join(packageDir, "imports", name)),
      );
    });

    it("never matches a load of the same name under another root", () => {
      installPackageSource();
      const fromPackage = PackageCaller.load("motor") as LoadFile;
      const fromWorkspace = load("motor") as LoadFile;
      expect(fromPackage.compareTo(fromWorkspace)).toBe(false);
      expect(fromWorkspace.compareTo(load("motor") as LoadFile)).toBe(true);
      expect(fromPackage.compareTo(PackageCaller.load("motor") as LoadFile)).toBe(true);
    });

    it("asks the asset provider under the package's key", () => {
      installPackageSource();
      const asked: string[] = [];
      setAssetProvider((rel) => {
        asked.push(rel);
        const file = rel.startsWith(PACKAGE_KEY) ? join(packageDir, rel.slice(PACKAGE_KEY.length)) : join(workspace, rel);
        return fs.existsSync(file) ? fs.readFileSync(file) : null;
      });
      expect(volumeLoadedBy(PackageCaller.load("motor"))).toBeCloseTo(8000, 6);
      expect(asked).toContain("packages/@acme/kit/1.0.0/imports/motor.brep");
      expect(asked).not.toContain("imports/motor.brep");
    });

    it("reads a package without a provider key from disk alone", () => {
      installPackageSource(null);
      const asked: string[] = [];
      setAssetProvider((rel) => {
        asked.push(rel);
        return null;
      });
      expect(volumeLoadedBy(PackageCaller.load("motor"))).toBeCloseTo(8000, 6);
      expect(asked).toEqual([]);
    });
  });

  describe("text().font()", () => {
    let fonts: [FontFile, FontFile] | null = null;

    beforeAll(async () => {
      fonts = await twoFontFiles();
      if (!fonts) {
        return;
      }
      fs.mkdirSync(join(workspace, "fonts"), { recursive: true });
      fs.mkdirSync(join(packageDir, "fonts"), { recursive: true });
      fs.copyFileSync(fonts[0].path, join(workspace, "fonts", "brand.ttf"));
      fs.copyFileSync(fonts[1].path, join(packageDir, "fonts", "brand.ttf"));
    });

    /** The family a text's font file opens as, through the root `.font()` resolved. */
    function familyOf(text: Text): string {
      const root = (text as unknown as { _fontRoot: AssetRoot | null })._fontRoot;
      return FontRegistry.resolve({ font: "fonts/brand.ttf", root }).familyName;
    }

    it("reads a package file's font file in the package, the consumer's in the workspace", () => {
      if (!fonts) {
        return; // no two .ttf families on this machine to copy; skip
      }
      installPackageSource();
      expect(familyOf(PackageCaller.text("A", "fonts/brand.ttf"))).toBe(fonts[1].family);
      expect(familyOf(new Text("A").font("fonts/brand.ttf"))).toBe(fonts[0].family);
      expect(familyOf(PackageCaller.text("A", "fonts/brand.ttf", { from: "project" }))).toBe(fonts[0].family);
      expect(PackageCaller.text("A", "fonts/brand.ttf").compareTo(new Text("A").font("fonts/brand.ttf"))).toBe(false);
    });

    it("keys the font cache by root behind an asset provider, which gives no stamp", () => {
      if (!fonts) {
        return; // no two .ttf families on this machine to copy; skip
      }
      const workspaceFont = fs.readFileSync(fonts[0].path);
      const packageFont = fs.readFileSync(fonts[1].path);
      setAssetProvider((rel) => {
        if (rel === "fonts/brand.ttf") {
          return workspaceFont;
        }
        return rel === `${PACKAGE_KEY}fonts/brand.ttf` ? packageFont : null;
      });
      try {
        expect(FontRegistry.resolve({ font: "fonts/brand.ttf" }).familyName).toBe(fonts[0].family);
        expect(FontRegistry.resolve({ font: "fonts/brand.ttf", root: packageRoot() }).familyName).toBe(fonts[1].family);
      } finally {
        FontRegistry.forgetLocalFiles();
      }
    });

    it("fails a package's missing font file naming the package, never reading the workspace's", () => {
      installPackageSource();
      fs.mkdirSync(join(workspace, "fonts"), { recursive: true });
      fs.writeFileSync(join(workspace, "fonts", "only-here.ttf"), "not read");
      const text = PackageCaller.text("A", "fonts/only-here.ttf");
      const root = (text as unknown as { _fontRoot: AssetRoot | null })._fontRoot;
      expect(() => FontRegistry.resolve({ font: "fonts/only-here.ttf", root })).toThrow(
        "Font file not found: fonts/only-here.ttf in @acme/kit@1.0.0. "
        + "If the name comes from the model using the package, read it with .font(name, { from: 'project' }).",
      );
    });

    it("leaves a system family name to the system, whatever file wrote the call", () => {
      installPackageSource();
      const text = PackageCaller.text("A", "Helvetica");
      expect((text as unknown as { _fontRoot: AssetRoot | null })._fontRoot).toBeNull();
    });

    it("refuses a from value it does not know", () => {
      expect(() => new Text("A").font("fonts/brand.ttf", { from: "home" as never })).toThrow(
        "text().font(): from must be 'package' or 'project', not 'home'",
      );
    });
  });

  describe("callerFileIn", () => {
    const ENGINE = "/repo/lib/dist/";

    it("takes the innermost frame outside the engine, skipping built-ins and anonymous frames", () => {
      const stack = [
        "Error",
        "    at AssetRoots.callerFile (file:///repo/lib/dist/io/asset-roots.js:10:5)",
        "    at new LoadFile (file:///repo/lib/dist/features/load.js:20:3)",
        "    at Array.map (<anonymous>)",
        "    at node:internal/modules/run_main:1:1",
        "    at eval (virtual:live-render:/lib/%40acme/kit/1.0.0/parts/motor.part.js:4:3)",
        "    at PartDefinition.materialize (file:///repo/lib/dist/features/part-definition.js:9:9)",
        "    at /ws/rig.assembly.js:3:1",
      ].join("\n");
      expect(AssetRoots.callerFileIn(stack, ENGINE)).toBe("/lib/@acme/kit/1.0.0/parts/motor.part.js");
    });

    it("counts the engine's tests as code of their own", () => {
      const stack = [
        "Error",
        "    at new LoadFile (/repo/lib/dist/features/load.js:20:3)",
        "    at helper (/repo/lib/dist/tests/helpers/caller.js:2:2)",
      ].join("\n");
      expect(AssetRoots.callerFileIn(stack, ENGINE)).toBe("/repo/lib/dist/tests/helpers/caller.js");
    });

    it("reads a Windows frame", () => {
      const stack = [
        "Error",
        "    at new LoadFile (file:///C:/repo/lib/dist/features/load.js:20:3)",
        "    at file:///C:/Users/me/My%20Project/a.part.js:1:1",
      ].join("\n");
      expect(AssetRoots.callerFileIn(stack, "C:/repo/lib/dist/")).toBe("C:/Users/me/My Project/a.part.js");
    });

    it("answers null when every frame is the engine's", () => {
      expect(AssetRoots.callerFileIn("Error\n    at f (/repo/lib/dist/index.js:1:1)", ENGINE)).toBeNull();
    });
  });

  describe("rootFor", () => {
    it("answers null for a source that throws, and for no file", () => {
      AssetRoots.use(() => {
        throw new Error("boom");
      });
      expect(AssetRoots.rootFor("/x/a.part.js")).toBeNull();
      AssetRoots.use(() => packageRoot());
      expect(AssetRoots.rootFor(null)).toBeNull();
      expect(AssetRoots.rootFor("/x/a.part.js")).toEqual(packageRoot());
    });
  });
});
