// lib/auth.js
// ─────────────────────────────────────────────────────────────────────────────
// Shared server-side helpers for ALTER.EGO API routes.
//
// WHY THIS EXISTS
// Until v133 every endpoint took `userId` straight from the request body and
// trusted it. That let anyone with DevTools (a) spend or read ANY user's
// credits/gallery by passing a different UUID, (b) skip credit deduction in
// image.js by omitting userId, and (c) hit our endpoints from any website
// because CORS was "*". This file fixes all three at the source.
//
// HOW IT WORKS — compliant with the "no client-side DB" rule
// The browser already holds a Supabase session. It sends the session's access
// token in `Authorization: Bearer <jwt>`. Here, SERVER-SIDE, we verify that JWT
// and derive the trusted userId from it. The browser never names a userId again;
// the token is the identity. This does NOT use sb.from()/sb.rpc() in the client
// — verification happens here on the server with the Supabase client.
//
// IMPORTANT: lib/ is NOT counted against Vercel's 12-function ceiling. Only
// files directly inside /api are serverless functions. Helpers imported from
// /lib are bundled into the functions that import them. We remain at 11/12.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

// Allowed browser origins. Tighten CORS from "*" to our own surfaces only, so
// these endpoints can't be driven from an attacker's page. Add any new
// front-end origin (e.g. a staging domain) here.
const ALLOWED_ORIGINS = [
  'https://alter-ego.photography',
  'https://www.alter-ego.photography',
];

// Set CORS headers based on the request Origin. If the Origin isn't in our
// allowlist we fall back to the canonical production origin (so same-origin
// server-to-server and curl still work, but arbitrary sites are not echoed
// back a permissive ACAO).
export function applyCors(req, res) {
  const origin = req.headers?.origin;
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// A service-key client, used only for the lightweight JWT verification call
// below. (getUser(jwt) validates the token against the project; it does not
// require RLS bypass, but reusing the service client is simplest and stays
// server-side.)
function serviceClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// Pull the bearer token out of the Authorization header.
function bearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

// Verify the caller and return their trusted user id.
//
// Returns { userId, user } on success. On failure it writes a 401 to `res`
// and returns null — callers should `if (!auth) return;` immediately.
//
// Usage in a handler:
//   const auth = await requireUser(req, res);
//   if (!auth) return;                 // 401 already sent
//   const userId = auth.userId;        // TRUSTED — derived from the JWT
export async function requireUser(req, res) {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Not signed in (missing token).' });
    return null;
  }
  try {
    const supabase = serviceClient();
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      res.status(401).json({ error: 'Session expired. Please sign in again.' });
      return null;
    }
    return { userId: data.user.id, user: data.user, supabase };
  } catch (e) {
    res.status(401).json({ error: 'Could not verify session.' });
    return null;
  }
}
