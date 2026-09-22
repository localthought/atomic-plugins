import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import type { ReflectorConfig } from '../config/index.js';
import {
  buildAuthUrl,
  exchangeCode,
  fetchAccount,
  type AuthProfile,
} from '../oauth/oauth.js';
import type { RemoteStorageManager } from '../remotestorage/manager.js';
import { buildZip } from '../sync/zip.js';
import type { ReflectionService } from '../reflect/service.js';
import type { ActiveSession, SessionManager } from './session.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '..', '..', '..', 'public');

const SESSION_COOKIE = 'reflector_session';
const OAUTH_STATE_COOKIE = 'reflector_oauth_state';
const RS_STATE_COOKIE = 'reflector_rs_state';

// The document collections the calendar UI presents. These names are the app's
// own vocabulary for the resources declared in the CRUD-causality overlay; the
// engine resolves everything else (URLs, params, hierarchy) from the document.
const CALENDAR_COLLECTION = 'calendarList';
const EVENT_COLLECTION = 'events';

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return undefined;
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

/** Wires up all HTTP routes: OAuth connect, full read, browse/edit, status, and ZIP download. */
export function createApp(
  config: ReflectorConfig,
  sessions: SessionManager,
  profile: AuthProfile,
  remoteStorage: RemoteStorageManager,
  reflection?: ReflectionService,
): Express {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/assets', express.static(publicDir));

  // Reflection mode: expose the status of the background reflect loop and a
  // "reflect now" trigger that runs one pass on demand (the seam a live-test
  // harness kicks). Both go through the service's serialized chain.
  if (reflection) {
    app.get('/api/reflect/status', (_req, res) => {
      res.json(reflection.status());
    });
    app.post(
      '/api/reflect',
      asyncRoute(async (_req, res) => {
        try {
          const summary = await reflection.reflectNow();
          res.json(summary);
        } catch (error) {
          // reflectNow() already recorded this on `status()` as `lastError`;
          // surface it here too instead of falling through to Express's
          // generic, message-less 500 page (localthought/reflector#31).
          res.status(502).json({
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  }

  // True only when there's an actual authorization endpoint to send the
  // browser to. Client id/secret alone aren't enough: a document that has no
  // oauth2 authorizationCode flow (or failed to derive one) falls back to an
  // inert `AuthProfile` with an empty `authorizationUrl` — building the
  // consent-screen URL from that yields a bare `?query` string, which the
  // browser resolves as a redirect back to the *current* path, looping
  // `/auth/login` on itself forever (ERR_TOO_MANY_REDIRECTS).
  const configured = (): boolean =>
    Boolean(
      config.oauth.clientId &&
        config.oauth.clientSecret &&
        profile.authorizationUrl &&
        profile.tokenUrl,
    );

  const requireSession = (
    req: Request,
    res: Response,
  ): ActiveSession | undefined => {
    const session = sessions.authorized(readCookie(req, SESSION_COOKIE));
    if (!session) {
      res.status(401).json({ error: 'not_connected' });
      return undefined;
    }
    return session;
  };

  app.get('/', (_req, res) => {
    res.sendFile(resolve(publicDir, 'index.html'));
  });

  // --- OAuth ---------------------------------------------------------------
  app.get('/auth/login', (_req, res) => {
    if (!configured()) {
      res
        .status(500)
        .send(
          !profile.authorizationUrl || !profile.tokenUrl
            ? 'This Reflector instance has no interactive OAuth flow to ' +
                'connect through (the configured document declares no ' +
                'oauth2 authorizationCode security scheme).'
            : 'OAuth is not configured. Set OAUTH_CLIENT_ID and ' +
                'OAUTH_CLIENT_SECRET and restart.',
        );
      return;
    }
    const state = randomUUID();
    res.cookie(OAUTH_STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax' });
    res.redirect(buildAuthUrl(profile, config.oauth, state));
  });

  app.get(
    '/auth/callback',
    asyncRoute(async (req, res) => {
      const code =
        typeof req.query['code'] === 'string' ? req.query['code'] : undefined;
      const state =
        typeof req.query['state'] === 'string' ? req.query['state'] : undefined;
      const expected = readCookie(req, OAUTH_STATE_COOKIE);
      res.clearCookie(OAUTH_STATE_COOKIE);
      if (!code || !state || state !== expected) {
        res
          .status(400)
          .send('Invalid OAuth callback (state mismatch or missing code).');
        return;
      }
      const tokens = await exchangeCode(profile, config.oauth, code);
      const account = await fetchAccount(profile, tokens);
      const session = await sessions.connect(tokens, account);
      res.cookie(SESSION_COOKIE, session.sessionId, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 30,
      });
      res.redirect('/');
    }),
  );

  app.post(
    '/api/disconnect',
    asyncRoute(async (req, res) => {
      await sessions.disconnect(readCookie(req, SESSION_COOKIE));
      res.clearCookie(SESSION_COOKIE);
      res.json({ ok: true });
    }),
  );

  app.get('/api/me', (req, res) => {
    const session = sessions.authorized(readCookie(req, SESSION_COOKIE));
    res.json({
      connected: Boolean(session),
      configured: configured(),
      account: session?.account ?? null,
      connectedAt: session?.connectedAt ?? null,
      storage: sessions.storageStatus(session),
      // Reflection-mode deployments run an unattended background sync between
      // two systems of record with no per-user connect flow; when present the
      // UI shows that status instead of the interactive Connect screen.
      reflection: reflection ? reflection.status() : null,
    });
  });

  // --- remoteStorage -------------------------------------------------------
  // Discover the account and hand back the OAuth authorize URL to redirect to.
  app.post(
    '/api/remotestorage/connect',
    asyncRoute(async (req, res) => {
      // remoteStorage is where *this user's* copy goes, so they must be
      // connected first; the connection is tied to their session below.
      if (!requireSession(req, res)) {
        return;
      }
      const body = req.body as { userAddress?: unknown };
      const userAddress =
        typeof body.userAddress === 'string' ? body.userAddress.trim() : '';
      if (!userAddress) {
        res.status(400).json({ error: 'user_address_required' });
        return;
      }
      try {
        const { authUrl, state } =
          await remoteStorage.beginConnect(userAddress);
        res.cookie(RS_STATE_COOKIE, state, {
          httpOnly: true,
          sameSite: 'lax',
        });
        res.json({ authUrl });
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : 'discovery_failed',
        });
      }
    }),
  );

  // The OAuth redirect target: a tiny page that reads the implicit-grant token
  // out of the URL fragment (which never reaches the server) and posts it back.
  app.get('/remotestorage/callback', (_req, res) => {
    res.sendFile(resolve(publicDir, 'remotestorage-callback.html'));
  });

  // Receive the token the callback page extracted from the fragment.
  app.post(
    '/api/remotestorage/token',
    asyncRoute(async (req, res) => {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      const state = readCookie(req, RS_STATE_COOKIE);
      res.clearCookie(RS_STATE_COOKIE);
      const body = req.body as { token?: unknown; state?: unknown };
      const token = typeof body.token === 'string' ? body.token : '';
      if (!state || !token) {
        res.status(400).json({ error: 'missing_state_or_token' });
        return;
      }
      // If the provider echoed `state` in the fragment, it must match the cookie.
      if (
        typeof body.state === 'string' &&
        body.state &&
        body.state !== state
      ) {
        res.status(400).json({ error: 'state_mismatch' });
        return;
      }
      try {
        const connection = remoteStorage.completeConnect(state, token);
        await sessions.setRemoteStorage(session.sessionId, connection);
        res.json({ ok: true, storage: remoteStorage.status(connection) });
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : 'connect_failed',
        });
      }
    }),
  );

  // Connects a remoteStorage account from a token the client already has
  // (e.g. handed to Reflector via a `#remotestorage=...&access_token=...` URL
  // fragment), bypassing the OAuth redirect dance in the two routes above.
  app.post(
    '/api/remotestorage/connect-with-token',
    asyncRoute(async (req, res) => {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      const body = req.body as { userAddress?: unknown; token?: unknown };
      const userAddress =
        typeof body.userAddress === 'string' ? body.userAddress.trim() : '';
      const token = typeof body.token === 'string' ? body.token : '';
      if (!userAddress || !token) {
        res.status(400).json({ error: 'user_address_and_token_required' });
        return;
      }
      try {
        const connection = await remoteStorage.connectWithToken(
          userAddress,
          token,
        );
        await sessions.setRemoteStorage(session.sessionId, connection);
        res.json({ ok: true, storage: remoteStorage.status(connection) });
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : 'connect_failed',
        });
      }
    }),
  );

  app.post(
    '/api/remotestorage/disconnect',
    asyncRoute(async (req, res) => {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      await sessions.clearRemoteStorage(session.sessionId);
      res.json({ ok: true, storage: remoteStorage.status(undefined) });
    }),
  );

  // --- Full read -----------------------------------------------------------
  app.post(
    '/api/read',
    asyncRoute(async (req, res) => {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      const summary = await session.engine.fullRead();
      // Present the generic result in the calendar UI's terms.
      const calendars = summary.collections
        .filter((c) => c.collection === CALENDAR_COLLECTION)
        .reduce((sum, c) => sum + c.count, 0);
      const events = summary.collections
        .filter((c) => c.collection === EVENT_COLLECTION)
        .reduce((sum, c) => sum + c.count, 0);
      res.json({ calendars, events, ...summary });
    }),
  );

  // --- Browse & edit -------------------------------------------------------
  app.get(
    '/api/calendars',
    asyncRoute(async (req, res) => {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      res.json({ calendars: await session.engine.list(CALENDAR_COLLECTION) });
    }),
  );

  app.get(
    '/api/calendars/:calendarId/events',
    asyncRoute(async (req, res) => {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      res.json({
        events: await session.engine.list(EVENT_COLLECTION, {
          calendarId: req.params.calendarId,
        }),
      });
    }),
  );

  app.post(
    '/api/calendars/:calendarId/events',
    asyncRoute(async (req, res) => {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      const result = await session.engine.create(
        EVENT_COLLECTION,
        req.body as Record<string, unknown>,
        { calendarId: req.params.calendarId },
      );
      res.status(201).json(result);
    }),
  );

  app.patch(
    '/api/calendars/:calendarId/events/:eventId',
    asyncRoute(async (req, res) => {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      const result = await session.engine.update(
        EVENT_COLLECTION,
        req.params.eventId,
        req.body as Record<string, unknown>,
        { calendarId: req.params.calendarId },
      );
      res.json(result);
    }),
  );

  app.delete(
    '/api/calendars/:calendarId/events/:eventId',
    asyncRoute(async (req, res) => {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      res.json(
        await session.engine.remove(EVENT_COLLECTION, req.params.eventId, {
          calendarId: req.params.calendarId,
        }),
      );
    }),
  );

  // --- Sync status ---------------------------------------------------------
  app.get('/api/status', (req, res) => {
    const session = requireSession(req, res);
    if (!session) {
      return;
    }
    const status = session.engine.status();
    // The UI keys sync badges by event id; expose the generic record id as such.
    res.json({
      ...status,
      changes: status.changes.map((change) => ({
        ...change,
        eventId: change.id,
      })),
    });
  });

  // --- ZIP download --------------------------------------------------------
  app.get(
    '/api/download/zip',
    asyncRoute(async (req, res) => {
      const session = requireSession(req, res);
      if (!session) {
        return;
      }
      const buffer = await buildZip(await session.engine.exportRecords());
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="reflector-export-${stamp}.zip"`,
      );
      res.send(buffer);
    }),
  );

  return app;
}
