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
import iconShieldCheck from '@tabler/icons/outline/shield-check.svg?raw';
import iconBolt from '@tabler/icons/outline/bolt.svg?raw';
import iconArrowBackUp from '@tabler/icons/outline/arrow-back-up.svg?raw';
import iconFilePencil from '@tabler/icons/outline/file-pencil.svg?raw';
import iconPencil from '@tabler/icons/outline/pencil.svg?raw';
import iconCamera from '@tabler/icons/outline/camera.svg?raw';
import iconBallpen from '@tabler/icons/outline/ballpen.svg?raw';
import iconScribble from '@tabler/icons/outline/scribble.svg?raw';
import iconArrowUpRight from '@tabler/icons/outline/arrow-up-right.svg?raw';
import iconOval from '@tabler/icons/outline/oval.svg?raw';
import iconRectangle from '@tabler/icons/outline/rectangle.svg?raw';
import iconLetterT from '@tabler/icons/outline/letter-t.svg?raw';
import iconArrowForwardUp from '@tabler/icons/outline/arrow-forward-up.svg?raw';
import iconTrash from '@tabler/icons/outline/trash.svg?raw';
import iconLogin from '@tabler/icons/outline/login-2.svg?raw';
import iconPin from '@tabler/icons/outline/pin.svg?raw';
import iconPaperclip from '@tabler/icons/outline/paperclip.svg?raw';
import iconEye from '@tabler/icons/outline/eye.svg?raw';
import iconCubeOff from '@tabler/icons/outline/cube-off.svg?raw';
import iconAdjustments from '@tabler/icons/outline/adjustments-horizontal.svg?raw';
import iconPointer from '@tabler/icons/outline/pointer.svg?raw';
import iconMapPin from '@tabler/icons/outline/map-pin.svg?raw';

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
  /** Permission mode "Ask before edits". */
  ASK: iconShieldCheck,
  /** Permission mode "Apply edits automatically". */
  AUTO: iconBolt,
  REVERT: iconArrowBackUp,
  FILE_EDIT: iconFilePencil,
  RENAME: iconPencil,
  /** Capture the viewport to mark it up. */
  CAPTURE: iconCamera,
  /** Mark up an attached image. */
  MARKUP: iconBallpen,
  /** The markup tools and its redo (undo is {@link REVERT}'s arrow, clear {@link DELETE}'s bin). */
  MARK_PEN: iconScribble,
  MARK_ARROW: iconArrowUpRight,
  MARK_ELLIPSE: iconOval,
  MARK_RECT: iconRectangle,
  MARK_TEXT: iconLetterT,
  REDO: iconArrowForwardUp,
  DELETE: iconTrash,
  SIGN_IN: iconLogin,
  /** Keep the live reference chip. */
  PIN: iconPin,
  /** Attach an image to the message. */
  ATTACH: iconPaperclip,
  /** Show a proposed variant in the viewport. */
  VIEW: iconEye,
  /** A variant's tile with no picture to show. */
  NO_PICTURE: iconCubeOff,
  /** A parameter card. */
  PARAMS: iconAdjustments,
  /** Pick in the viewport: a question answered by clicking geometry. */
  PICK: iconPointer,
  /** What the agent points at in the viewport. */
  POINT: iconMapPin,

  /** `svg` in a span sized by `className`. */
  span(svg: string, className = '[&>svg]:size-4'): HTMLSpanElement {
    const span = document.createElement('span');
    span.className = `inline-flex items-center justify-center shrink-0 ${className}`;
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = svg;
    return span;
  },
};
