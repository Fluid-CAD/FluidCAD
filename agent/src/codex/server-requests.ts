// Requests `codex app-server` sends to its client (docs/agent-chat-plan.md
// §5.2). With the thread configuration of thread-config.ts none should
// arrive; if one does, FluidCAD never approves a native action: approvals
// are declined, elicitations cancelled, anything else refused, and the user
// is told.

import type { JsonRpcServerRequest, ServerRequestAnswer } from './json-rpc.ts';

export type DeclinedRequest = {
  answer: ServerRequestAnswer;
  /** What the transcript says; null for requests the user need not hear about. */
  notice: string | null;
};

export function declineServerRequest(request: JsonRpcServerRequest): DeclinedRequest {
  const p = (request.params && typeof request.params === 'object' ? request.params : {}) as Record<string, any>;
  switch (request.method) {
    case 'item/commandExecution/requestApproval': {
      const command = typeof p.command === 'string' && p.command !== '' ? ` (\`${clip(p.command)}\`)` : '';
      return {
        answer: { result: { decision: 'decline' } },
        notice: `Codex asked to run a command${command}. FluidCAD declined: commands are not available here.`,
      };
    }
    case 'item/fileChange/requestApproval':
      return {
        answer: { result: { decision: 'decline' } },
        notice: 'Codex asked to change files directly. FluidCAD declined: changes go through FluidCAD\'s own tools.',
      };
    case 'item/permissions/requestApproval':
      // No permission granted, for this turn only.
      return {
        answer: { result: { permissions: {}, scope: 'turn' } },
        notice: 'Codex asked for more permissions. FluidCAD declined.',
      };
    case 'mcpServer/elicitation/request': {
      const server = typeof p.serverName === 'string' ? ` from ${p.serverName}` : '';
      return {
        answer: { result: { action: 'cancel', content: null, _meta: null } },
        notice: `Codex relayed a question${server} that FluidCAD cannot show; it was cancelled.`,
      };
    }
    case 'item/tool/requestUserInput':
      return {
        answer: { result: { answers: {} } },
        notice: 'Codex asked a question through a form FluidCAD cannot show; it got no answer.',
      };
    case 'item/tool/call':
      return {
        answer: { result: { contentItems: [], success: false } },
        notice: null,
      };
    case 'applyPatchApproval':
    case 'execCommandApproval':
      // The older approval requests take a review decision.
      return {
        answer: { result: { decision: { denied: { rejection: 'FluidCAD does not allow this action.' } } } },
        notice:
          request.method === 'execCommandApproval'
            ? 'Codex asked to run a command. FluidCAD declined: commands are not available here.'
            : 'Codex asked to change files directly. FluidCAD declined: changes go through FluidCAD\'s own tools.',
      };
    default:
      // Token refresh, attestation and anything newer: not supported by this client.
      return {
        answer: { error: { code: -32601, message: `FluidCAD does not support ${request.method}.` } },
        notice: null,
      };
  }
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}
