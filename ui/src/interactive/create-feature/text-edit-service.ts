import { Group, LineSegments } from 'three';
import {
  applyTextEdit, FeatureEditTarget, getTextPreview, ParsedFeatureStatement, TextEditOptions,
} from '../../api';
import { DebouncedTask } from '../../helpers/debounced-task';
import { PlaneData, SceneObjectRender } from '../../types';
import { Viewer } from '../../viewer';
import { worldToSketch2D } from '../sketch-plane-utils';
import { EditSession, EditSessionInfo } from '../edit-session';
import { TextPanel } from '../tools/text-panel';
import { TextPreviewMesh } from '../tools/text-preview-mesh';
import { ApplyRunner } from './apply-runner';
import { SketchUISuspender } from './sketch-suspender';

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
  private sketchUI: SketchUISuspender;
  private runner: ApplyRunner<TextEditOptions>;
  /**
   * The dual debounced preview: the statement text the transform will write
   * (also surfacing drift refusals before Apply), then the outline geometry
   * — both under one cancellation scope, so a newer edit drops both.
   */
  private preview: DebouncedTask;

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
    this.sketchUI = new SketchUISuspender(viewer, hooks);
    this.previewGroup.userData.isMetaShape = true;
    this.previewGroup.renderOrder = 3;
    this.panel = new TextPanel(container);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.schedulePreview();
    };

    this.runner = new ApplyRunner({
      panel: this.panel,
      isArmed: () => this.armed && this.editTarget !== null,
      build: () => this.buildRequest(),
      send: (request, extras) => applyTextEdit(this.editTarget!, { ...request, ...extras }),
      onApplied: () => this.exit('apply'),
      failMessage: () => 'Could not apply the edit.',
      // The statement preview rides the dual DebouncedTask below instead —
      // it chains the outline render under the same cancellation scope.
      validateApply: () => {
        const values = this.panel.values();
        return !('error' in values) && values.text.trim() === ''
          ? { error: 'Enter the text to render.' }
          : null;
      },
    });
    this.preview = new DebouncedTask(PREVIEW_DEBOUNCE_MS,
      (signal, isCurrent) => this.runPreview(signal, isCurrent));
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
    this.sketchUI.suspend();
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

  /** The edit request for the current form state, or the blocking message. */
  private buildRequest(): TextEditOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    return { ...values, expectedStatement: this.session.expectedStatement };
  }

  exit(editEnd: 'apply' | 'cancel' | 'gone' = 'cancel'): void {
    if (!this.armed) {
      return;
    }
    this.armed = false;
    this.session.end(editEnd);
    this.editTarget = null;
    this.pathText = null;
    this.preview.cancel();
    this.panel.hide();
    this.panel.setTitle(null);
    this.clearPreviewMesh();
    this.viewer.sceneContext.scene.remove(this.previewGroup);
    // A render always follows the session end (the cancel path clears the
    // breakpoint, an apply rebuilds) — resume lazily and let it re-enter.
    this.sketchUI.resume(false);
  }

  private schedulePreview(): void {
    if (!this.armed) {
      return;
    }
    this.preview.schedule();
  }

  private async runPreview(signal: AbortSignal, isCurrent: () => boolean): Promise<void> {
    if (!this.armed || this.runner.isApplying || !this.editTarget) {
      return;
    }
    const values = this.panel.values();
    if ('error' in values) {
      this.panel.setPreview(null);
      this.renderPreviewMesh([]);
      return;
    }

    try {
      const result = await applyTextEdit(this.editTarget, {
        ...values,
        expectedStatement: this.session.expectedStatement,
        preview: true,
        signal,
      });
      if (!isCurrent() || !this.armed) {
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
    let geometry: Awaited<ReturnType<typeof getTextPreview>>;
    try {
      geometry = await getTextPreview({
        text,
        position: this.anchor,
        plane: {
          origin: this.plane.origin,
          normal: this.plane.normal,
          xDirection: this.plane.xDirection,
        },
        options,
      }, signal);
    } catch {
      return; // aborted
    }
    if (!isCurrent() || !this.armed) {
      return;
    }
    this.renderPreviewMesh(geometry?.polylines ?? []);
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
