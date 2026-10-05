import type * as Monaco from 'monaco-editor/editor/editor.api.js';

/** The slice of Monaco's editor namespace the raw OpenCascade loader watches. */
type ModelSource = {
  onDidCreateModel(listener: (model: Monaco.editor.ITextModel) => void): { dispose(): void };
  getModels(): Monaco.editor.ITextModel[];
};

/**
 * The declarations of raw OpenCascade — the OpenCascade binding the engine
 * runs on, behind `fluidcad/sdk/occt` and a feature's `this.occ()` scope.
 * They are about 2 MB — more than every other engine declaration together —
 * and nearly every file never needs them, so they load the first time a
 * workspace file reaches raw OpenCascade: an import of `fluidcad/sdk/occt`,
 * or `this.occ(` in a feature. Until then the binding's types read as
 * `any`; afterwards `new oc.gp_Pnt(` completes like any engine call. The
 * load itself is the caller's (`loadOcctTypes` in engine-types.ts), so this
 * watch needs nothing of Monaco but its models.
 */
export class OcctTypes {
  /** What in a file's text means it reaches raw OpenCascade. */
  static readonly TRIGGER = /['"]fluidcad\/sdk\/occt['"]|\b(?:this|super)\.occ\s*\(/;

  private static loading: Promise<void> | null = null;
  private static readonly subscriptions: { dispose(): void }[] = [];

  /** Whether a file's text reaches raw OpenCascade. */
  static reaches(text: string): boolean {
    return OcctTypes.TRIGGER.test(text);
  }

  /**
   * Watch every model, open now and created later, and load the
   * declarations the first time one reaches raw OpenCascade.
   */
  static watch(editor: ModelSource, load: () => Promise<void>): void {
    const check = (model: Monaco.editor.ITextModel): boolean => {
      if (OcctTypes.loading || !OcctTypes.reaches(model.getValue())) {
        return false;
      }
      OcctTypes.loading = load();
      OcctTypes.stopWatching();
      return true;
    };
    const follow = (model: Monaco.editor.ITextModel): void => {
      if (OcctTypes.loading || check(model)) {
        return;
      }
      OcctTypes.subscriptions.push(model.onDidChangeContent(() => {
        check(model);
      }));
    };
    OcctTypes.subscriptions.push(editor.onDidCreateModel(follow));
    for (const model of editor.getModels()) {
      follow(model);
    }
  }

  /** Whether the declarations are loaded or loading. */
  static get requested(): boolean {
    return OcctTypes.loading !== null;
  }

  /** Forget the watch and the load — tests only. */
  static reset(): void {
    OcctTypes.stopWatching();
    OcctTypes.loading = null;
  }

  private static stopWatching(): void {
    for (const subscription of OcctTypes.subscriptions.splice(0)) {
      subscription.dispose();
    }
  }
}
