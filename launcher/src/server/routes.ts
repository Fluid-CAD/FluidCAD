import { Router, type NextFunction, type Request, type Response } from 'express';
import path from 'path';
import { ProjectsRootError, type ProjectsRoot } from '../projects/projects-root.ts';
import { StartCallError, pathArgument, textArgument, type StartApi } from '../start/api.ts';
import type { FolderListing } from '../start/contract.ts';
import type { EventStream } from './events.ts';
import { FolderError, checkFolder, checkNewProject, defaultFolder, listFolder } from './folders.ts';
import type { SessionRegistry } from './session-registry.ts';

/**
 * The start server's API: the start screen's data and actions (the same
 * {@link StartApi} the desktop app answers over IPC), the sessions behind the
 * tabs projects open in, the page's folder picker, and the event stream.
 * Every route sits behind the session cookie and the same-origin checks
 * (`auth.ts`), mounted by `launcher-server.ts`.
 *
 * With a projects root (`--projects`), every path a call names has to be a
 * project in that folder, and the folder picker sees that folder only —
 * checked here, before any call reaches the sessions or the disk, so that no
 * route can forget to.
 */

export type ApiDeps = {
  api: StartApi;
  sessions: SessionRegistry;
  events: EventStream;
  /** The folder every project lives in, or null when projects may live anywhere. */
  projectsRoot?: ProjectsRoot | null;
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
      const refused = err instanceof StartCallError || err instanceof FolderError || err instanceof ProjectsRootError;
      response.status(refused ? 400 : 500).json({ error: err?.message ?? String(err) });
    }
  };
}

/** The root's listing, as the picker's only folder: nothing above it, nowhere else to start. */
function listRoot(root: ProjectsRoot): FolderListing {
  const listing = listFolder(root.path);
  return { ...listing, parent: null, roots: [root.path] };
}

export function createApiRouter(deps: ApiDeps): Router {
  const { api, sessions, events } = deps;
  const root = deps.projectsRoot ?? null;
  const router = Router();
  const body = (request: Request): Record<string, unknown> =>
    request.body && typeof request.body === 'object' ? request.body : {};
  /** A project's path from a call: absolute, and in the projects root when there is one. */
  const project = (value: unknown): string => {
    const workspacePath = pathArgument(value, 'a project path');
    return root ? root.confine(workspacePath) : workspacePath;
  };
  /** A folder the picker may look at: with a root, the root itself and nothing else. */
  const folder = (value: unknown): string => {
    const folderPath = pathArgument(value, 'a folder');
    if (root && path.resolve(folderPath) !== root.path) {
      throw new ProjectsRootError(`Only the projects folder ${root.path} can be listed.`);
    }
    return folderPath;
  };

  // The start screen, as the desktop app's IPC has it.
  router.post('/start/hello', route((request) => api.hello(body(request).protocol)));
  router.get('/start/appearance', route(() => api.appearance()));
  router.get('/start/projects', route(() => api.list()));
  router.get('/start/feed', route(() => api.feed()));
  router.post('/start/dismiss-notification', route((request) => api.dismissNotification(body(request).id)));
  router.post('/start/forget', route((request) => api.forget(project(body(request).path))));
  router.get('/start/engine-options', route((request) => api.engineOptions(project(request.query.path))));
  router.post(
    '/start/preview-upgrade',
    route((request) =>
      api.previewUpgrade(project(body(request).path), body(request).version, (progress) =>
        events.send('upgrade-progress', progress),
      ),
    ),
  );
  router.post('/start/apply-pin', route((request) => api.applyPin(project(body(request).path), body(request).version)));
  router.post('/start/close', route((request) => sessions.close(project(body(request).path))));
  /** The page came back into view: retake the previews of the projects it has running. */
  router.post('/start/refresh-previews', route(async () => ({ captured: await sessions.capturePreviews() })));

  // The tabs projects open in.
  router.post(
    '/sessions',
    route((request) => sessions.open(project(body(request).path), { create: body(request).create === true })),
  );
  router.get(
    '/sessions',
    route((request) => {
      const workspacePath = project(request.query.path);
      return sessions.view(workspacePath) ?? { phase: 'closed', project: { path: workspacePath, name: path.basename(workspacePath) } };
    }),
  );
  router.post('/sessions/retry', route((request) => sessions.retry(project(body(request).path))));
  router.post('/sessions/cancel', route((request) => sessions.cancel(project(body(request).path))));

  // The page's own folder picker.
  router.get(
    '/folders',
    route((request) => {
      if (root) {
        if (request.query.path !== undefined) {
          folder(request.query.path);
        }
        return listRoot(root);
      }
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
      const { path: target, parent, name } = body(request);
      if (parent !== undefined) {
        const parentPath = folder(parent);
        const projectName = textArgument(name, 'a project name');
        if (root) {
          // The name has to make a project path the root accepts, or the create it leads to would be refused.
          try {
            root.confine(root.projectPath(projectName));
          } catch {
            return { path: root.projectPath(projectName), state: 'invalid-name' as const };
          }
        }
        return checkNewProject(parentPath, projectName);
      }
      return checkFolder(root ? project(target) : pathArgument(target, 'a folder'));
    }),
  );

  router.get('/events', events.connect);

  return router;
}
