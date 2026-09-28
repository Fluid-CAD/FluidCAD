import { Router, type NextFunction, type Request, type Response } from 'express';
import path from 'path';
import { StartCallError, pathArgument, textArgument, type StartApi } from '../start/api.ts';
import type { EventStream } from './events.ts';
import { FolderError, checkFolder, checkNewProject, defaultFolder, listFolder } from './folders.ts';
import type { SessionRegistry } from './session-registry.ts';

/**
 * The start server's API: the start screen's data and actions (the same
 * {@link StartApi} the desktop app answers over IPC), the sessions behind the
 * tabs projects open in, the page's folder picker, and the event stream.
 * Every route sits behind the session cookie and the same-origin checks
 * (`auth.ts`), mounted by `launcher-server.ts`.
 */

export type ApiDeps = {
  api: StartApi;
  sessions: SessionRegistry;
  events: EventStream;
};

/** Wrap a handler so a refusal answers 400 with its sentence, and anything else 500. */
function route(handler: (request: Request, response: Response) => unknown) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await handler(request, response);
      if (!response.headersSent) {
        response.json(result ?? { ok: true });
      }
    } catch (err: any) {
      if (response.headersSent) {
        next(err);
        return;
      }
      const refused = err instanceof StartCallError || err instanceof FolderError;
      response.status(refused ? 400 : 500).json({ error: err?.message ?? String(err) });
    }
  };
}

export function createApiRouter(deps: ApiDeps): Router {
  const { api, sessions, events } = deps;
  const router = Router();
  const body = (request: Request): Record<string, unknown> =>
    request.body && typeof request.body === 'object' ? request.body : {};

  // The start screen, as the desktop app's IPC has it.
  router.post('/start/hello', route((request) => api.hello(body(request).protocol)));
  router.get('/start/appearance', route(() => api.appearance()));
  router.get('/start/projects', route(() => api.list()));
  router.get('/start/feed', route(() => api.feed()));
  router.post('/start/dismiss-notification', route((request) => api.dismissNotification(body(request).id)));
  router.post('/start/forget', route((request) => api.forget(body(request).path)));
  router.get('/start/engine-options', route((request) => api.engineOptions(request.query.path)));
  router.post(
    '/start/preview-upgrade',
    route((request) =>
      api.previewUpgrade(body(request).path, body(request).version, (progress) => events.send('upgrade-progress', progress)),
    ),
  );
  router.post('/start/apply-pin', route((request) => api.applyPin(body(request).path, body(request).version)));
  router.post('/start/close', route((request) => sessions.close(pathArgument(body(request).path, 'a project path'))));
  /** The page came back into view: retake the previews of the projects it has running. */
  router.post('/start/refresh-previews', route(async () => ({ captured: await sessions.capturePreviews() })));

  // The tabs projects open in.
  router.post(
    '/sessions',
    route((request) =>
      sessions.open(pathArgument(body(request).path, 'a project path'), { create: body(request).create === true }),
    ),
  );
  router.get(
    '/sessions',
    route((request) => {
      const workspacePath = pathArgument(request.query.path, 'a project path');
      return sessions.view(workspacePath) ?? { phase: 'closed', project: { path: workspacePath, name: path.basename(workspacePath) } };
    }),
  );
  router.post('/sessions/retry', route((request) => sessions.retry(pathArgument(body(request).path, 'a project path'))));
  router.post('/sessions/cancel', route((request) => sessions.cancel(pathArgument(body(request).path, 'a project path'))));

  // The page's own folder picker.
  router.get(
    '/folders',
    route((request) => {
      if (request.query.path === undefined) {
        try {
          return listFolder(defaultFolder());
        } catch {
          return listFolder(path.parse(process.cwd()).root);
        }
      }
      return listFolder(pathArgument(request.query.path, 'a folder'));
    }),
  );
  router.post(
    '/folders/check',
    route((request) => {
      const { path: folder, parent, name } = body(request);
      if (parent !== undefined) {
        return checkNewProject(pathArgument(parent, 'a folder'), textArgument(name, 'a project name'));
      }
      return checkFolder(pathArgument(folder, 'a folder'));
    }),
  );

  router.get('/events', events.connect);

  return router;
}
