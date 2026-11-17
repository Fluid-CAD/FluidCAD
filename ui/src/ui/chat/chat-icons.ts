// The chat panel's icons: Tabler outline SVGs as `?raw` strings, static
// markup only (never model text). In the panel's own chunk, not icons.ts.

import iconArrowUp from '@tabler/icons/outline/arrow-up.svg?raw';
import iconPlayerStop from '@tabler/icons/outline/player-stop.svg?raw';
import iconPlus from '@tabler/icons/outline/plus.svg?raw';
import iconX from '@tabler/icons/outline/x.svg?raw';
import iconChevronDown from '@tabler/icons/outline/chevron-down.svg?raw';
import iconChevronRight from '@tabler/icons/outline/chevron-right.svg?raw';
import iconCheck from '@tabler/icons/outline/check.svg?raw';
import iconAlertTriangle from '@tabler/icons/outline/alert-triangle.svg?raw';
import iconAlertCircle from '@tabler/icons/outline/alert-circle.svg?raw';
import iconInfoCircle from '@tabler/icons/outline/info-circle.svg?raw';
import iconBan from '@tabler/icons/outline/ban.svg?raw';
import iconClock from '@tabler/icons/outline/clock.svg?raw';
import iconCopy from '@tabler/icons/outline/copy.svg?raw';
import iconMessage from '@tabler/icons/outline/message.svg?raw';
import iconBrain from '@tabler/icons/outline/bulb.svg?raw';
import iconTool from '@tabler/icons/outline/tool.svg?raw';
import iconTerminal from '@tabler/icons/outline/terminal-2.svg?raw';
import iconExternal from '@tabler/icons/outline/external-link.svg?raw';
import iconSettings from '@tabler/icons/outline/settings.svg?raw';
import iconRefresh from '@tabler/icons/outline/refresh.svg?raw';
import iconPlayerPlay from '@tabler/icons/outline/player-play.svg?raw';
import iconSparkles from '@tabler/icons/outline/sparkles.svg?raw';

export const ChatIcons = {
  SEND: iconArrowUp,
  STOP: iconPlayerStop,
  NEW: iconPlus,
  CLOSE: iconX,
  CHEVRON_DOWN: iconChevronDown,
  CHEVRON_RIGHT: iconChevronRight,
  CHECK: iconCheck,
  WARNING: iconAlertTriangle,
  ERROR: iconAlertCircle,
  INFO: iconInfoCircle,
  DENIED: iconBan,
  WAITING: iconClock,
  COPY: iconCopy,
  SESSION: iconMessage,
  THINKING: iconBrain,
  TOOL: iconTool,
  TERMINAL: iconTerminal,
  EXTERNAL: iconExternal,
  SETTINGS: iconSettings,
  REFRESH: iconRefresh,
  CONTINUE: iconPlayerPlay,
  AGENT: iconSparkles,

  /** `svg` in a span sized by `className`. */
  span(svg: string, className = '[&>svg]:size-4'): HTMLSpanElement {
    const span = document.createElement('span');
    span.className = `inline-flex items-center justify-center shrink-0 ${className}`;
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = svg;
    return span;
  },
};
