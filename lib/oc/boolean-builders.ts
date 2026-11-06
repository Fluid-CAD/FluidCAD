/** An OCCT boolean API algorithm: `BRepAlgoAPI_Cut`, `_Fuse`, `_Common`, `_Section`, `_Splitter`, `_BuilderAlgo`. */
export type BooleanBuilder = { Clear(): void; delete(): void };

/**
 * Releases the OCCT boolean algorithms (`BRepAlgoAPI_*`).
 *
 * The ocjs binding's `delete()` frees such an algorithm without running its
 * C++ destructor — the history it holds keeps its reference count after
 * `delete()` — and that destructor is what clears it. So `delete()` alone
 * leaves the intersection data structure (the pave filler), the builder and
 * the history on the wasm heap: about 150 kB for the boolean of two small
 * cylinders, more for real bodies, on every fuse, cut, common, section and
 * split the engine runs. Accumulated over a session — or a test run, which
 * shares one heap — that fills the heap's 4 GB ceiling, and the next large
 * allocation traps ("memory access out of bounds"). `Clear()` frees all of
 * it, so every `BRepAlgoAPI` algorithm goes through {@link release}, never
 * through `delete()` alone.
 *
 * The `BOPAlgo_*` builders (`BOPAlgo_CellsBuilder`, `BOPAlgo_Splitter`)
 * free their pave filler only in that destructor, whatever is called first;
 * the engine runs their `BRepAlgoAPI` counterparts instead wherever one does
 * the same job.
 */
export class BooleanBuilders {
  static release(builder: BooleanBuilder | null | undefined): void {
    if (!builder) {
      return;
    }
    try {
      builder.Clear();
    } finally {
      builder.delete();
    }
  }
}
