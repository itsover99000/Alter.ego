import { applyCors, requireUser } from '../lib/auth.js';

// ── /api/generate ────────────────────────────────────────────────────────────
// Claude Haiku selfie analysis → structured style prompt.
//
// v133 hardening. Before, this endpoint forwarded ANY request body straight to
// the Anthropic API with our key — an open, unauthenticated proxy anyone could
// script to run their own Claude workloads on our bill. We now:
//   1. Require a signed-in user (JWT) before spending any Anthropic tokens.
//   2. Pin `model` to a Haiku-only allowlist so it can't be redirected to an
//      arbitrary (expensive) model.
//   3. Cap `max_tokens` server-side.
// The client still supplies `system` + `messages` (this is what carries the
// gender-aware prompt logic), so behaviour is unchanged for the real app.
//
// NOTE (future hardening, not done here to avoid behaviour risk): the full
// system prompt could be assembled server-side from the style key so the client
// can't influence it at all. Deferred deliberately — flagged for a later build.

const ALLOWED_MODELS = new Set([
  'claude-haiku-4-5-20251001',
]);
const MAX_TOKENS_CAP = 1500;

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Must be signed in to spend Anthropic tokens on our key.
  const auth = await requireUser(req, res);
  if (!auth) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'API key not configured' } });

  const { model, max_tokens, system, messages } = req.body || {};

  // Pin the model — reject anything not on the allowlist.
  if (!ALLOWED_MODELS.has(model)) {
    return res.status(400).json({ error: { message: 'Unsupported model.' } });
  }
  // Cap tokens regardless of what the client asked for.
  const cappedMaxTokens = Math.min(Number(max_tokens) || 1000, MAX_TOKENS_CAP);

  const safeBody = { model, max_tokens: cappedMaxTokens, system, messages };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(safeBody)
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}
