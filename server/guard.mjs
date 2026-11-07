import { cookieName, COOKIE_MAX_AGE_S, mintCookie, readCookie, siteHost, tokenVerifier, verifyCookie } from './session.mjs';

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const SIGNED_OUT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Sign in · Cairnboard</title></head><body><main>
<h1>Cairnboard is running</h1>
<p>This browser is not signed in. Run <code>cairn open</code> in a terminal to open it here.</p>
<p lang="tr">Bu tarayıcıda oturum açık değil. Burada açmak için terminalde <code>cairn open</code> çalıştırın.</p>
</main></body></html>
`;

// Leaves /auth for / without a script (CSP) and without a redirect; the token leaves the address bar with it.
const SIGNED_IN = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/">
<title>Cairnboard</title></head><body><main>
<p><a href="/">Open Cairnboard</a></p>
<p lang="tr"><a href="/">Cairnboard'u aç</a></p>
</main></body></html>
`;

function send(req, res, status, headers, body = '') {
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  return false;
}

/** Baseline for every response: security headers and read-only methods. Returns false when it answered. */
export function guard(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  // Writes arrive in a later stage together with the Origin and Sec-Fetch-Site checks.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(req, res, 405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }, 'Method not allowed.');
  }
  return true;
}

/**
 * The server's access check (spec §5.1–5.2), run before anything else:
 * - Host must be exactly <site name>:<port> (see siteHost). Anything else, 127.0.0.1 and localhost included, gets 421
 *   without a redirect: a redirect would tell any local account the private site name. This also stops DNS rebinding.
 * - /auth?t=<one-time token> sets the session cookie and moves on to / so the token leaves the address bar.
 * - Every other request, reads included, needs the cookie; built assets under /_astro/ are public.
 */
export function createGuard({ port, key, instance, now = Date.now }) {
  if (!Number.isSafeInteger(port) || !Buffer.isBuffer(key)) throw new TypeError('createGuard needs a port and a key.');
  const origin = `${siteHost(key)}:${port}`;
  const name = cookieName(port);
  const useToken = tokenVerifier(key, port, instance);
  const signedOut = (req, res) => send(req, res, 401, { 'Content-Type': 'text/html; charset=utf-8' }, SIGNED_OUT);

  return (req, res) => {
    if (guard(req, res) === false) return false;
    if (req.headers.host !== origin) {
      return send(req, res, 421, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Open Cairnboard with: cairn open\n');
    }

    const url = new URL(req.url, `http://${origin}`);
    // The router reads the raw path, so a path counts only when URL parsing left it unchanged: no `//host`,
    // dot segments, encoded dots or backslashes that the two could read differently.
    const raw = req.url.split('?')[0];
    const plain = url.pathname === raw && !raw.startsWith('//');
    const signedIn = verifyCookie(key, port, readCookie(req.headers.cookie, name), now());
    if (plain && url.pathname === '/auth') {
      if (!signedIn && !useToken(url.searchParams.get('t'), now())) return signedOut(req, res);
      const headers = { 'Content-Type': 'text/html; charset=utf-8' };
      if (!signedIn) {
        headers['Set-Cookie'] = `${name}=${mintCookie(key, port, now())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}`;
      }
      // Not a redirect: the login link arrives from a file:// launcher, and browsers do not send a SameSite=Strict
      // cookie on a redirect chain another site started. A refresh from this page is a same-site navigation.
      return send(req, res, 200, headers, SIGNED_IN);
    }
    if (plain && url.pathname.startsWith('/_astro/') && !/%2e/iu.test(raw)) return true;
    return signedIn ? true : signedOut(req, res);
  };
}
