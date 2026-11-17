// What every tool may change, and the MCP annotations that say so.
//
// Clients key on the annotations: Claude Code runs read-only tools in
// parallel, and Codex's default approval mode asks before the others. A tool
// missing from TOOL_CLASSES fails `buildServer`, so none ships unclassified.

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export type McpToolClass =
  /** Docs and skills bundled with the server; no engine involved. */
  | 'read-docs'
  /** Reads the rendered scene. */
  | 'read-scene'
  /** Renders or reads the view without moving the user's camera. */
  | 'read-view'
  /** Reads workspace files. */
  | 'read-source'
  /** Writes workspace files. */
  | 'edit-files'
  /** Changes the session's render or view state; files are untouched. */
  | 'edit-session'
  /** Reads or writes paths that may lie outside the workspace. */
  | 'outside-workspace';

export const TOOL_CLASSES: Readonly<Record<string, McpToolClass>> = {
  list_workspaces: 'read-docs',
  list_docs: 'read-docs',
  read_doc: 'read-docs',
  search_docs: 'read-docs',
  get_api_signature: 'read-docs',
  get_type_definition: 'read-docs',
  list_skills: 'read-docs',
  read_skill: 'read-docs',

  get_scene_summary: 'read-scene',
  list_shapes: 'read-scene',
  get_compile_error: 'read-scene',
  list_global_params: 'read-scene',
  get_shape_properties: 'read-scene',
  get_face_properties: 'read-scene',
  get_edge_properties: 'read-scene',
  resolve_selection: 'read-scene',
  validate: 'read-scene',
  interfere: 'read-scene',
  measure: 'read-scene',
  hit_test: 'read-scene',

  screenshot: 'read-view',
  screenshot_multi: 'read-view',
  screenshot_shape: 'read-view',
  get_camera_state: 'read-view',
  wait_for_idle: 'read-view',

  list_fluid_files: 'read-source',
  read_file: 'read-source',

  write_file: 'edit-files',
  edit_range: 'edit-files',

  recompute: 'edit-session',
  select_configuration: 'edit-session',
  rollback_to: 'edit-session',
  add_breakpoint: 'edit-session',
  clear_breakpoints: 'edit-session',

  import_step: 'outside-workspace',
  export: 'outside-workspace',
  pack: 'outside-workspace',
};

/** Tools that overwrite files: workspace sources, or an export / pack target. */
const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_range', 'export', 'pack']);

export function isReadOnlyClass(toolClass: McpToolClass): boolean {
  return toolClass.startsWith('read-');
}

/** The annotations a tool is registered with. Throws for a tool with no class. */
export function toolAnnotations(name: string): ToolAnnotations {
  const toolClass = Object.hasOwn(TOOL_CLASSES, name) ? TOOL_CLASSES[name] : undefined;
  if (!toolClass) {
    throw new Error(`MCP tool "${name}" has no entry in TOOL_CLASSES (mcp/src/tool-classes.ts).`);
  }
  if (isReadOnlyClass(toolClass)) {
    return { readOnlyHint: true };
  }
  return { readOnlyHint: false, destructiveHint: DESTRUCTIVE_TOOLS.has(name) };
}
