// @wc-ignore-file
/**
 * A JSON POST to an AtomicServer route that requires a version 2 request
 * signature (atomic-server#1832): `/plugin-release`, `/plugin-release-pin`,
 * `/plugin-run`, `/app-write`, `/bind-drive` and the others listed in
 * atomic-server's `docs/src/authentication.md`. Those routes answer 401 to a
 * version 1 signature, a session cookie, or a replayed signature, so this
 * signs every call anew with `@tomic/lib`'s `signedRequestInit`, over the
 * method, the full URL and exactly the body string it sends.
 *
 * Shared by the specs and tooling under `integrations/tooling/`. A plugin
 * package calls `signedRequestInit` itself rather than importing this file,
 * to stay inside its own folder.
 */
import { type Agent, signedRequestInit } from '@tomic/lib';

export interface SignedPostResult {
  status: number;
  contentType: string;
  text: string;
  /** The body parsed as JSON, or `undefined` when it isn't JSON. */
  json: unknown;
}

export async function signedPost(
  agent: Agent,
  url: string,
  body: unknown,
): Promise<SignedPostResult> {
  const response = await fetch(
    url,
    await signedRequestInit(url, agent, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  const text = await response.text();
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }

  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    text,
    json,
  };
}
