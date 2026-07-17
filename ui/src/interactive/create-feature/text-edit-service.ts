import { Group, LineSegments } from 'three';
import {
  applyTextEdit, FeatureEditTarget, getTextPreview, ParsedFeatureStatement,
} from '../../api';
import { PlaneData, SceneObjectRender } from '../../types';
import { Viewer } from '../../viewer';
import { worldToSketch2D } from '../sketch-plane-utils';
import { EditSession, EditSessionInfo } from '../edit-session';
import { TextPanel } from '../tools/text-panel';
import { TextPreviewMesh } from '../tools/text-preview-mesh';

const PREVIEW_DEBOUNCE_MS = 250;

/**
 * The text edit dialog (timeline double-click on a text row). The session
 * rolls the viewport back to just before the statement — the old glyphs
 * vanish and the live outline preview renders in their place, so edits show
 * against exactly the scene the statement builds in. The preview frame
 * comes from the paused parent sketch: its plane, and its cursor — where
 * the text statement starts. Text following a path previews as the
 * statement text only (the path layout needs the path's geometry).
 * Apply rewrites the statement in place; the rebuild is the confirmation.
 */
export class TextEditService {
  private panel: TextPanel;
  private session = new EditSession();
  private editTarget: FeatureEditTarget | null = null;
  private armed = false;
  /** The statement's own path argument; suppresses the outline preview. */
  private pathText: string | null = null;
  private plane: PlaneData | null = null;
  private anchor: [number, number] | null = null;
  private previewGroup = new Group();
  private suspendedSketchUI = false;
  private applying = false;
  private previewTimer: number | null = null;
  private previewAbort: AbortController | null = null;
  private previewSeq = 0;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private hooks: {
      /** Another dialog may own the view — let it release first. */
      onEnter?: () => void;
      /** An edit session armed while a sketch is edited — release the sketch UI. */
      onSuspendSketchUI?: () => void;
      /** The suspension ended without an apply — restore the sketch UI. */
      onResumeSketchUI?: () => void;
    } = {},
  ) {
    this.previewGroup.userData.isMetaShape = true;
    this.previewGroup.renderOrder = 3;
    this.panel = new TextPanel(container);
    this.panel.onApply = () => void this.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.schedulePreview();
    };
  }

  get isActive(): boolean {
    return this.armed;
  }

  /**
   * Open the dialog over an existing text statement, prefilled from its
   * parsed options. The session places the viewport at the pre-statement
   * boundary; the preview frame resolves when that render lands.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'text' }>,
    info: Omit<EditSessionInfo, 'target'>,
  ): void {
    if (this.armed) {
      this.exit();
    }
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = target;
    this.pathText = parsed.pathText;
    this.plane = null;
    this.anchor = null;
    this.suspendSketchUI();
    this.session.begin({ ...info, target });
    this.viewer.sceneContext.scene.add(this.previewGroup);
    this.panel.setTitle('Edit text');
    this.panel.setValues({
      text: parsed.text,
      size: parsed.size,
      font: parsed.font,
      weight: parsed.weight,
      italic: parsed.italic,
      align: parsed.align,
      lineSpacing: parsed.lineSpacing,
      letterSpacing: parsed.letterSpacing,
    });
    this.panel.show();
    void TextPanel.loadFontFamilies().then((families) => {
      if (this.armed) {
        this.panel.setFonts(families);
      }
    });
    this.schedulePreview();
  }

  /**
   * Every render lands here. The session keeps the viewport at the
   * pre-statement boundary; when it settles there, the preview frame is
   * re-derived from the paused parent sketch.
   */
  handleSceneRendered(sceneObjects: SceneObjectRender[], stop: number, isRollback: boolean): void {
    const state = this.session.onSceneRendered(sceneObjects, stop, isRollback);
    if (state === 'inactive') {
      return;
    }
    if (!this.armed) {
      this.session.end('gone');
      return;
    }
    if (state === 'gone') {
      this.exit('gone');
      return;
    }
    if (state === 'waiting') {
      return;
    }
    this.resolvePreviewFrame(sceneObjects);
    this.schedulePreview();
  }

  /**
   * The outline preview's frame: the parent sketch's plane, and its cursor
   * at the boundary — the sketch is paused just before the text statement,
   * so its cursor is exactly where the text starts. Standalone text (no
   * parent sketch) keeps the statement preview only.
   */
  private resolvePreviewFrame(sceneObjects: SceneObjectRender[]): void {
    this.plane = null;
    this.anchor = null;
    const index = this.session.boundary?.index ?? -1;
    const row = sceneObjects[index];
    const parent = row?.parentId
      ? sceneObjects.find(o => o.id === row.parentId)
      : null;
    const plane: PlaneData | undefined = parent?.object?.plane;
    if (!plane) {
      return;
    }
    this.plane = plane;
    const cursor = parent!.object?.currentPosition;
    this.anchor = cursor ? worldToSketch2D(cursor, plane) : [0, 0];
  }

  private async apply(): Promise<void> {
    if (!this.armed || this.applying || !this.editTarget) {
      return;
    }
    const values = this.panel.values();
    if ('error' in values) {
      this.panel.setMessage(values.error);
      return;
    }
    if (values.text.trim() === '') {
      this.panel.setMessage('Enter the text to render.');
      return;
    }
    this.applying = true;
    this.panel.setApplyEnabled(false);
    try {
      const result = await applyTextEdit(this.editTarget, {
        ...values,
        expectedStatement: this.session.expectedStatement,
      });
      if (result.success) {
        this.exit('apply');
      } else {
        this.panel.setMessage(result.reason ?? 'Could not apply the edit.');
      }
    } finally {
      this.applying = false;
      this.panel.setApplyEnabled(true);
    }
  }

  exit(editEnd: 'apply' | 'cancel' | 'gone' = 'cancel'): void {
    if (!this.armed) {
      return;
    }
    this.armed = false;
    this.session.end(editEnd);
    this.editTarget = null;
    this.pathText = null;
    this.cancelPreview();
    this.panel.hide();
    this.panel.setTitle(null);
    this.clearPreviewMesh();
    this.viewer.sceneContext.scene.remove(this.previewGroup);
    // A render always follows the session end (the cancel path clears the
    // breakpoint, an apply rebuilds) — resume lazily and let it re-enter.
    this.resumeSketchUI();
  }

  private suspendSketchUI(): void {
    if (this.suspendedSketchUI) {
      return;
    }
    this.suspendedSketchUI = true;
    this.viewer.suspendSketchEditing();
    this.hooks.onSuspendSketchUI?.();
  }

  private resumeSketchUI(): void {
    if (!this.suspendedSketchUI) {
      return;
    }
    this.suspendedSketchUI = false;
    this.viewer.resumeSketchEditing(false);
  }

  // -------------------------------------------------------------------------
  // Debounced previews: the statement text the transform will write (also
  // surfacing drift refusals before Apply), and the outline geometry.
  // -------------------------------------------------------------------------

  private schedulePreview(): void {
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
    }
    if (!this.armed) {
      return;
    }
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      void this.runPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  private async runPreview(): Promise<void> {
    if (!this.armed || this.applying || !this.editTarget) {
      return;
    }
    const values = this.panel.values();
    if ('error' in values) {
      this.panel.setPreview(null);
      this.renderPreviewMesh([]);
      return;
    }
    const seq = ++this.previewSeq;
    this.previewAbort?.abort();
    const abort = new AbortController();
    this.previewAbort = abort;

    try {
      const result = await applyTextEdit(this.editTarget, {
        ...values,
        expectedStatement: this.session.expectedStatement,
        preview: true,
        signal: abort.signal,
      });
      if (seq !== this.previewSeq || !this.armed) {
        return;
      }
      this.panel.setPreview(result.success ? result.preview ?? null : null);
      if (!result.success && result.reason) {
        // The statement changed shape under the dialog (an undo, a
        // concurrent edit) — surface the refusal before Apply.
        this.panel.setMessage(result.reason);
      }
    } catch {
      return; // aborted
    }

    if (!this.plane || this.anchor === null || this.pathText !== null || values.text === '') {
      this.renderPreviewMesh([]);
      return;
    }
    const { text, ...options } = values;
    const geometry = await getTextPreview({
      text,
      position: this.anchor,
      plane: {
        origin: this.plane.origin,
        normal: this.plane.normal,
        xDirection: this.plane.xDirection,
      },
      options,
    }, abort.signal);
    if (seq !== this.previewSeq || !this.armed) {
      return;
    }
    this.renderPreviewMesh(geometry?.polylines ?? []);
  }

  private cancelPreview(): void {
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.previewAbort?.abort();
    this.previewAbort = null;
    this.previewSeq++;
  }

  private renderPreviewMesh(polylines: number[][]): void {
    this.clearPreviewMesh();
    const mesh = TextPreviewMesh.build(polylines);
    if (mesh) {
      this.previewGroup.add(mesh);
    }
    this.viewer.sceneContext.requestRender();
  }

  private clearPreviewMesh(): void {
    while (this.previewGroup.children.length > 0) {
      const child = this.previewGroup.children[0] as LineSegments;
      this.previewGroup.remove(child);
      child.geometry?.dispose();
      (child.material as { dispose?: () => void })?.dispose?.();
    }
  }
}
