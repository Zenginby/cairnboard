import { cookieName, COOKIE_MAX_AGE_S, mintCookie, readCookie, tokenVerifier, verifyCookie } from './session.mjs';

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const SIGNED_OUT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Sign in · Cairnboard</title></head><body><main>
<h1>Cairnboard is running</h1>
<p>This browser is not signed in. Run <code>cairn open</code> in a terminal to open it here.</p>
<p lang="tr">Bu tarayıcıda oturum açık değil. Burada açmak için terminalde <code>cairn open</code> çalıştırın.</p>
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
 * - Host must be exactly 127.0.0.1:<port>; localhost:<port> is redirected there before any cookie check
 *   (the cookie belongs to 127.0.0.1); any other Host gets 421, which stops DNS rebinding.
 * - /auth?t=<one-time token> sets the session cookie and redirects to / so the token leaves the address bar.
 * - Every other request, reads included, needs the cookie; built assets under /_astro/ are public.
 */
export function createGuard({ port, key, instance, now = Date.now }) {
  if (!Number.isSafeInteger(port) || !Buffer.isBuffer(key)) throw new TypeError('createGuard needs a port and a key.');
  const origin = `127.0.0.1:${port}`;
  const name = cookieName(port);
  const useToken = tokenVerifier(key, port, instance);
  const signedOut = (req, res) => send(req, res, 401, { 'Content-Type': 'text/html; charset=utf-8' }, SIGNED_OUT);

  return (req, res) => {
    if (guard(req, res) === false) return false;
    const host = req.headers.host;
    if (host === `localhost:${port}`) {
      const path = typeof req.url === 'string' && req.url.startsWith('/') ? req.url : '/';
      return send(req, res, 302, { Location: `http://${origin}${path}` });
    }
    if (host !== origin) return send(req, res, 421, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Misdirected request.');

    const url = new URL(req.url, `http://${origin}`);
    const signedIn = verifyCookie(key, port, readCookie(req.headers.cookie, name), now());
    if (url.pathname === '/auth') {
      if (!signedIn && !useToken(url.searchParams.get('t'), now())) return signedOut(req, res);
      const headers = { Location: '/' };
      if (!signedIn) {
        headers['Set-Cookie'] = `${name}=${mintCookie(key, port, now())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}`;
      }
      return send(req, res, 303, headers);
    }
    if (url.pathname.startsWith('/_astro/')) return true;
    return signedIn ? true : signedOut(req, res);
  };
}
