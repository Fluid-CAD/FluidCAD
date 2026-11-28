// The hook a host puts around every tool call (`BuildServerOptions.toolGate`).
//
// The in-app agent uses it to ask the user before an edit runs and to record
// what each call returned. The MCP server only calls it; what it decides is
// the host's business.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** A tool call as the gate sees it: the tool's name and its validated arguments. */
export type McpToolCall = { name: string; input: unknown };

/**
 * `input`, on an allowed call: the arguments the tool runs with instead of
 * the model's (the user chose where an install goes). The schema already
 * accepted the model's; a gate only changes values the schema allows.
 */
export type McpToolGateDecision = { allow: true; input?: unknown } | { allow: false; message: string };

export type McpToolGate = {
  /**
   * Called before a tool runs, with the arguments the schema accepted. The
   * call waits for the promise, so the gate may hold it (an approval prompt).
   * `{ allow: false }` skips the tool and answers with a tool error whose
   * text is `message`; a rejection does the same with the error's message.
   * `signal` aborts when the client cancels the request (only on a transport
   * that delivers `notifications/cancelled`: the stateful HTTP one does).
   */
  before(call: McpToolCall, signal: AbortSignal): Promise<McpToolGateDecision>;
  /**
   * Called with the result of every call that ran, errors included (a tool
   * that throws is reported as the error result the client receives). Not
   * called for a denied call.
   */
  after(call: McpToolCall, result: CallToolResult): void;
};

type Handler = (args: unknown, extra: { signal: AbortSignal }) => CallToolResult | Promise<CallToolResult>;

/** A tool error result, shaped as the SDK shapes a handler's thrown error. */
export function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/**
 * Wrap a tool handler so `gate` sees the call before it runs and the result
 * after. Every tool registered by `buildServer` takes arguments, so the
 * handler is always `(args, extra)`.
 */
export function gateToolHandler<H>(gate: McpToolGate, name: string, handler: H): H {
  const run = handler as unknown as Handler;
  const gated: Handler = async (args, extra) => {
    const call: McpToolCall = { name, input: args };
    let decision: McpToolGateDecision;
    try {
      decision = await gate.before(call, extra.signal);
    } catch (e) {
      return toolError(e instanceof Error ? e.message : String(e));
    }
    if (decision.allow === false) {
      return toolError(decision.message);
    }
    let result: CallToolResult;
    try {
      result = await run(decision.input !== undefined ? decision.input : args, extra);
    } catch (e) {
      result = toolError(e instanceof Error ? e.message : String(e));
    }
    try {
      gate.after(call, result);
    } catch (e) {
      // The client still gets its result; a broken observer is the host's bug.
      console.error(`[fluidcad-mcp] toolGate.after failed for ${name}:`, e);
    }
    return result;
  };
  return gated as unknown as H;
}
