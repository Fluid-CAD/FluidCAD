import { describe, it } from "vitest";
import { writeFileSync } from "node:fs";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import { testRect } from "../helpers/profiles.js";
import { getOC } from "../../oc/init.js";
import { Profiler } from "../../common/profiler.js";
import type { FeatureBuildContext } from "../../sdk/index.js";
import type { SceneObject } from "../../common/scene-object.js";
import type { ExtrudeBase } from "../../features/extrude-base.js";
import { SceneDisposal } from "../../rendering/scene-disposal.js";
import { defineTwist, type TwistDefinition } from "../fixtures/custom-features/twist.js";

// The heap a custom feature's raw OpenCascade code leaves behind, measured
// in a process of its own: occt.test.ts spawns this file with
// FLUIDCAD_OCCT_HEAP_OUT set and asserts on what it writes there. In the
// suite's own run it is skipped — the measure fills the kernel's heap on
// purpose, and the control leaks megabytes a build.
//
// The probe: the binding exposes the allocator but not the heap's size, so
// the WebAssembly memory is caught as it grows, and the free part of it is
// counted by taking 1 MB blocks until it has to grow once more. mimalloc
// keeps some of what a probe frees out of the next probe's reach, so two
// probes in a row differ by tens of megabytes with nothing in between: the
// measure reports that noise beside its numbers.

const OUT = process.env.FLUIDCAD_OCCT_HEAP_OUT;

let grows = 0;
let sizeBeforeGrow = 0;
const grow = WebAssembly.Memory.prototype.grow;
if (OUT) {
  WebAssembly.Memory.prototype.grow = function (this: WebAssembly.Memory, pages: number) {
    grows++;
    sizeBeforeGrow = this.buffer.byteLength;
    return grow.call(this, pages);
  };
}

/** The heap in use, MB: the memory's size less what 1 MB blocks still fit in it. */
function heapInUseMb(): number {
  const oc = getOC() as unknown as { ___libc_malloc(size: number): number; ___libc_free(ptr: number): void };
  const blocks: number[] = [];
  const start = grows;
  while (grows === start && blocks.length < 8192) {
    blocks.push(oc.___libc_malloc(1 << 20));
  }
  for (const block of blocks) {
    oc.___libc_free(block);
  }
  return sizeBeforeGrow / 2 ** 20 - (blocks.length - 1);
}

describe.runIf(OUT)("the heap under raw OpenCascade (its own process)", () => {
  setupOC();

  /**
   * Build the twist (with a bore: a raw boolean) `count` times on the
   * prism's top face and free each build as a render's compare or a
   * preview frees it, alternating its height so no build is the last one.
   */
  function measure(definition: TwistDefinition, count: number): { builds: number; growthMb: number; perBuildKb: number } {
    sketch("xy", () => {
      testRect(20, 20, { at: [-10, -10] });
    });
    const base = extrude(10) as unknown as ExtrudeBase;
    const scene = render();
    const face = base.endFaces();
    (face as unknown as SceneObject).build();
    const objects = scene.getSceneObjects();
    const context: FeatureBuildContext = {
      getSceneObjects: () => objects,
      getActiveSceneObjects: () => objects,
      getSceneObjectsFromTo: () => [],
      getTransform: () => null,
      getLastObject: () => null,
      getProfiler: () => new Profiler(),
    };
    const once = (height: number) => {
      const feature = new definition.Twist({ face, height, angle: 60, sections: 8, bore: 4 });
      const built = feature.buildPreview(context)!;
      SceneDisposal.releaseDetached([...built.shapes, ...built.scratch], scene.getAllSceneObjects());
    };
    for (let i = 0; i < 20; i++) {
      once(20 + (i % 2));
    }
    const before = heapInUseMb();
    for (let i = 0; i < count; i++) {
      once(20 + (i % 2));
    }
    const growthMb = heapInUseMb() - before;
    return { builds: count, growthMb, perBuildKb: (growthMb * 1024) / count };
  }

  it("measures the twist in its scope, and outside it", () => {
    const idleBefore = heapInUseMb();
    const probeNoiseMb = heapInUseMb() - idleBefore;
    const scoped = measure(defineTwist(), 1000);
    const control = measure(defineTwist({ scoped: false }), 80);
    writeFileSync(OUT!, JSON.stringify({ scoped, control, probeNoiseMb }));
  }, 240_000);
});
