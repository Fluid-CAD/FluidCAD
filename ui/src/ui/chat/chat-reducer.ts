import type { ChatEvent, ChatMessage, ChatPart, TurnRecord } from './chat-types';

/**
 * Folds one event of the session's stream (docs/agent-chat-plan.md §7.3)
 * into the transcript. The page's twin of `applyChatEvent` in
 * `agent/src/transcript.ts`, which the engine folds every event through
 * before it is sent: a page that replays the stream from a snapshot holds
 * exactly the engine's transcript. Keep the two in step.
 *
 * Pure: `messages` is not touched. The result shares every message and part
 * the event did not change, so a renderer can tell what moved by identity.
 * Events that do not touch messages (status, usage, title…) return
 * `messages` itself.
 */
export function reduceChat(messages: readonly ChatMessage[], event: ChatEvent): ChatMessage[] {
  switch (event.type) {
    case 'message-start': {
      if (messages.some((m) => m.id === event.message.id)) {
        return messages as ChatMessage[];
      }
      return [...messages, { ...event.message, parts: [] }];
    }
    case 'part-start': {
      return updateMessage(messages, event.messageId, (message) => {
        if (message.parts.some((p) => p.id === event.part.id)) {
          return message;
        }
        return { ...message, parts: [...message.parts, structuredClone(event.part)] };
      });
    }
    case 'part-delta': {
      return updatePart(messages, event.messageId, event.partId, (part) => {
        if (part.type !== 'text' && part.type !== 'reasoning') {
          return part;
        }
        return { ...part, text: part.text + event.text };
      });
    }
    case 'part-update': {
      return updatePart(messages, event.messageId, event.partId, (part) => ({ ...part, ...structuredClone(event.patch) }) as ChatPart);
    }
    default:
      return messages as ChatMessage[];
  }
}

/** Folds a whole sequence; what a client that saw every event from `messages` holds. */
export function reduceChatAll(messages: readonly ChatMessage[], events: Iterable<ChatEvent>): ChatMessage[] {
  let out = messages as ChatMessage[];
  for (const event of events) {
    out = reduceChat(out, event);
  }
  return out;
}

/**
 * Folds one event into the session's turn records — what `Session` in
 * `agent/src/session.ts` does to `record.turns` as it emits the event, so a
 * page holding a snapshot's `turns` follows revertibility live:
 *
 * - a user `message-start` opens its turn (the engine records the turn as it
 *   sends the user message), not revertible yet;
 * - `checkpoint` sets the turn's files to the event's full list; the turn is
 *   revertible while that list is not empty (`checkpointsChanged`);
 * - `reverted` ends its revertibility and stamps `revertedAt` (`revert`),
 *   keeping `files` as the engine does.
 *
 * `endedAt` and `endReason` come with snapshots only: no event carries them.
 * Pure, like {@link reduceChat}: `turns` comes back itself when the event
 * does not touch it. `now` stamps `revertedAt` (the event has no time).
 */
export function reduceTurns(
  turns: readonly TurnRecord[],
  event: ChatEvent,
  now: () => string = () => new Date().toISOString(),
): TurnRecord[] {
  switch (event.type) {
    case 'message-start': {
      const { message } = event;
      if (message.role !== 'user' || turns.some((t) => t.id === message.turnId)) {
        return turns as TurnRecord[];
      }
      return [...turns, { id: message.turnId, userMessageId: message.id, revertible: false }];
    }
    case 'checkpoint':
      return updateTurn(turns, event.turnId, (turn) => {
        const next: TurnRecord = { ...turn, revertible: event.files.length > 0 };
        if (event.files.length > 0) {
          next.files = [...event.files];
        } else {
          delete next.files;
        }
        return next;
      });
    case 'reverted':
      return updateTurn(turns, event.turnId, (turn) => ({ ...turn, revertible: false, revertedAt: now() }));
    default:
      return turns as TurnRecord[];
  }
}

function updateTurn(turns: readonly TurnRecord[], id: string, change: (turn: TurnRecord) => TurnRecord): TurnRecord[] {
  const index = turns.findIndex((t) => t.id === id);
  if (index < 0) {
    return turns as TurnRecord[];
  }
  const out = turns.slice();
  out[index] = change(turns[index]);
  return out;
}

/** The last message with `id` (the engine's `findMessage` searches from the end too). */
function indexOfMessage(messages: readonly ChatMessage[], id: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].id === id) {
      return i;
    }
  }
  return -1;
}

function updateMessage(
  messages: readonly ChatMessage[],
  id: string,
  change: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
  const index = indexOfMessage(messages, id);
  if (index < 0) {
    return messages as ChatMessage[];
  }
  const next = change(messages[index]);
  if (next === messages[index]) {
    return messages as ChatMessage[];
  }
  const out = messages.slice();
  out[index] = next;
  return out;
}

function updatePart(
  messages: readonly ChatMessage[],
  messageId: string,
  partId: string,
  change: (part: ChatPart) => ChatPart,
): ChatMessage[] {
  return updateMessage(messages, messageId, (message) => {
    const index = message.parts.findIndex((p) => p.id === partId);
    if (index < 0) {
      return message;
    }
    const next = change(message.parts[index]);
    if (next === message.parts[index]) {
      return message;
    }
    const parts = message.parts.slice();
    parts[index] = next;
    return { ...message, parts };
  });
}
