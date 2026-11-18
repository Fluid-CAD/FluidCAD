// One model of one provider, as the AI SDK takes it, with the options each
// provider wants (docs/agent-chat-plan.md Appendix A.3, §20.5, §20.6).

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel, ModelMessage } from 'ai';
import type { ApiModelInfo } from './models.ts';
import type { ResolvedProvider } from './providers.ts';

type ProviderOptions = Record<string, Record<string, any>>;

/** The AI SDK model for `model` on provider `p`. `images`: images reach the model (§20.6: moved out of tool messages for OpenAI-compatible servers). */
export function createLanguageModel(p: ResolvedProvider, model: string, options: { images: boolean; fetch?: typeof fetch }): LanguageModel {
  const apiKey = p.apiKey ?? undefined;
  const fetchOption = options.fetch ? { fetch: options.fetch } : {};
  switch (p.kind) {
    case 'anthropic':
      return createAnthropic({ apiKey, ...fetchOption })(model);
    case 'openai':
      return createOpenAI({ apiKey, ...fetchOption }).responses(model);
    case 'openrouter':
      return createOpenRouter({ apiKey, compatibility: 'strict', appName: 'FluidCAD', appUrl: 'https://fluidcad.io', ...fetchOption }).chat(model, {
        usage: { include: true },
      });
    case 'openai-compatible':
      return createOpenAICompatible({
        name: p.id,
        baseURL: p.baseURL ?? '',
        ...(apiKey ? { apiKey } : {}),
        includeUsage: true,
        supportsMultiPartToolContent: options.images,
        ...(options.images ? { transformRequestBody: moveToolImagesToUserMessages } : {}),
        ...fetchOption,
      }).chatModel(model);
  }
}

/**
 * What goes under `providerOptions` for a turn (Appendix A.3): Anthropic
 * adaptive thinking with summarized display, the effort, prompt caching of
 * the newest message (the call-level `cacheControl`, §20.6), no
 * temperature; OpenAI reasoning effort and summaries, nothing stored on
 * OpenAI's side (the history is ours, reasoning travels encrypted);
 * OpenRouter's reasoning effort. `effort` is used only when the model lists it.
 */
export function providerOptionsFor(p: ResolvedProvider, info: ApiModelInfo, effort: string | null): ProviderOptions {
  const level = effort && info.efforts?.includes(effort) ? effort : null;
  switch (p.kind) {
    case 'anthropic':
      return {
        anthropic: {
          ...(info.adaptiveThinking ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
          ...(level ? { effort: level } : {}),
          cacheControl: { type: 'ephemeral' },
        },
      };
    case 'openai':
      return {
        openai: info.reasoning
          ? { store: false, include: ['reasoning.encrypted_content'], reasoningSummary: 'auto', ...(level ? { reasoningEffort: level } : {}) }
          : { store: false },
      };
    case 'openrouter':
      return level ? { openrouter: { reasoning: { effort: level } } } : {};
    case 'openai-compatible':
      return level ? { [p.id]: { reasoningEffort: level } } : {};
  }
}

/** The system prompt; for Anthropic with the cache breakpoint that covers the tools and the prompt (§20.6). */
export function systemMessage(p: ResolvedProvider, instructions: string): { role: 'system'; content: string; providerOptions?: ProviderOptions } {
  return p.kind === 'anthropic'
    ? { role: 'system', content: instructions, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }
    : { role: 'system', content: instructions };
}

/** What stands in for an image a model cannot take. */
export const IMAGE_OMITTED_NOTE = '[An image was here; this model does not take images, so it was left out.]';

/**
 * `messages` with every image (file part) of user messages and tool results
 * replaced by {@link IMAGE_OMITTED_NOTE}, for a model without images. Never
 * base64 as text (§20.6). A tool result left with text only becomes plain
 * text. Returns the same array when there was nothing to change.
 */
export function withoutImages(messages: ModelMessage[]): ModelMessage[] {
  let changed = false;
  const out = messages.map((message) => {
    if (message.role === 'user' && Array.isArray(message.content)) {
      if (!message.content.some((part) => part.type === 'file' || part.type === 'image')) {
        return message;
      }
      changed = true;
      return {
        ...message,
        content: message.content.map((part) => (part.type === 'file' || part.type === 'image' ? { type: 'text' as const, text: IMAGE_OMITTED_NOTE } : part)),
      };
    }
    if (message.role === 'tool') {
      let touched = false;
      const content = message.content.map((part) => {
        if (part.type !== 'tool-result' || part.output.type !== 'content') {
          return part;
        }
        const value = part.output.value;
        if (!value.some((v) => v.type !== 'text')) {
          return part;
        }
        touched = true;
        const text = value.map((v) => (v.type === 'text' ? v.text : IMAGE_OMITTED_NOTE)).join('\n');
        return { ...part, output: { type: 'text' as const, value: text } };
      });
      if (!touched) {
        return message;
      }
      changed = true;
      return { ...message, content };
    }
    return message;
  });
  return changed ? out : messages;
}

/**
 * An OpenAI-compatible request body with the images of `tool` messages
 * moved into a `user` message right after them (§20.6: Ollama drops an
 * image inside a tool message, and reads it in a user message).
 */
export function moveToolImagesToUserMessages(body: Record<string, any>): Record<string, any> {
  if (!Array.isArray(body?.messages)) {
    return body;
  }
  const messages: any[] = [];
  let pending: any[] = [];
  const flush = () => {
    if (pending.length > 0) {
      messages.push({ role: 'user', content: [{ type: 'text', text: 'The images the tool calls above returned:' }, ...pending] });
      pending = [];
    }
  };
  for (const message of body.messages) {
    if (message?.role === 'tool' && Array.isArray(message.content)) {
      const images = message.content.filter((part: any) => part?.type === 'image_url');
      if (images.length > 0) {
        const text = message.content.filter((part: any) => part?.type !== 'image_url');
        messages.push({ ...message, content: text.length > 0 ? text : [{ type: 'text', text: '(an image, attached in the next message)' }] });
        pending.push(...images);
        continue;
      }
      messages.push(message);
      continue;
    }
    // The images follow the run of tool messages they came from.
    flush();
    messages.push(message);
  }
  flush();
  return { ...body, messages };
}
