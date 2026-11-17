import type { ChatEvent, ChatMessage, ChatPart } from './chat-types';

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
