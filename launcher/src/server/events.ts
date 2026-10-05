import type { Request, Response } from 'express';

/**
 * What the start server pushes to its pages, as Server-Sent Events on
 * `GET /api/events`: the recents changed, a comparison made progress, a
 * project's session moved on. The desktop app sends the same three over IPC;
 * a browser page gets them here, one stream per page, and `EventSource`
 * reconnects on its own after a network hiccup.
 */

export type LauncherEvent = 'changed' | 'upgrade-progress' | 'session';

/** Proxies drop a stream that stays silent; a comment line now and then keeps it open. */
const KEEP_ALIVE_MS = 25_000;

export class EventStream {
  private readonly clients = new Set<Response>();
  private readonly keepAlive: NodeJS.Timeout;

  constructor() {
    this.keepAlive = setInterval(() => this.write(': keep-alive\n\n'), KEEP_ALIVE_MS);
    this.keepAlive.unref();
  }

  /** Hold `response` open as an event stream until the page goes. */
  readonly connect = (request: Request, response: Response): void => {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(': connected\n\n');
    this.clients.add(response);
    request.on('close', () => this.clients.delete(response));
  };

  send(event: LauncherEvent, data: unknown = null): void {
    this.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** End every stream; the pages' `EventSource`s keep retrying until a start server answers again. */
  close(): void {
    clearInterval(this.keepAlive);
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
  }

  private write(chunk: string): void {
    for (const client of this.clients) {
      client.write(chunk);
    }
  }
}
