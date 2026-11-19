import type { PermissionMode } from './chat-types';

/**
 * The permission modes as the Agent panel's switch and Settings → Agent
 * name them (§12.1). A module of its own so Settings, in the page's main
 * chunk, does not pull in the panel.
 */
export const PERMISSION_MODES: { mode: PermissionMode; label: string; short: string; description: string }[] = [
  { mode: 'ask', label: 'Ask before edits', short: 'Ask', description: 'The agent asks before it changes a file.' },
  {
    mode: 'auto-edits',
    label: 'Apply edits automatically',
    short: 'Auto-apply',
    description: 'The agent changes project files without asking. It still asks before anything outside the project.',
  },
];
