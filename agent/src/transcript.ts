// Folds ChatEvents into a transcript. The session applies every event it
// emits through this, so its snapshot is always what a client that replayed
// the whole stream would hold; the page's `chat-reducer` does the same.

import type { ChatEvent, ChatMessage, ChatPart } from './types.ts';

/** Applies `event` to `messages` in place. Events that do not touch messages are ignored. */
export function applyChatEvent(messages: ChatMessage[], event: ChatEvent): void {
  switch (event.type) {
    case 'message-start': {
      if (!messages.some((m) => m.id === event.message.id)) {
        messages.push({ ...event.message, parts: [] });
      }
      return;
    }
    case 'part-start': {
      const message = findMessage(messages, event.messageId);
      if (message && !message.parts.some((p) => p.id === event.part.id)) {
        message.parts.push(structuredClone(event.part));
      }
      return;
    }
    case 'part-delta': {
      const part = findPart(messages, event.messageId, event.partId);
      if (part && (part.type === 'text' || part.type === 'reasoning')) {
        part.text += event.text;
      }
      return;
    }
    case 'part-update': {
      const part = findPart(messages, event.messageId, event.partId);
      if (part) {
        Object.assign(part, structuredClone(event.patch));
      }
      return;
    }
    default:
      return;
  }
}

export function findMessage(messages: ChatMessage[], id: string): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].id === id) {
      return messages[i];
    }
  }
  return undefined;
}

export function findPart(messages: ChatMessage[], messageId: string, partId: string): ChatPart | undefined {
  return findMessage(messages, messageId)?.parts.find((p) => p.id === partId);
}
