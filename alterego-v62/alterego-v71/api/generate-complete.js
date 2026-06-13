import { applyCors, requireUser } from '../lib/auth.js';

// ── /api/generate-complete ───────────────────────────────────────────────────
// Records a finished generation in the gallery (generations table) and bumps
// total_generations. It does NOT deduct credits — credit deduction happens
// atomically, server-side, in /api/image BEFORE the fal call (see image.js and
// DEPLOY_credit_race_fix.sql). Keeping deduction out of here is what makes the
// deploy overlap safe: an old cached client that still calls this endpoint can
// no longer double-charge, because this endpoint never touches credits.
//
// This endpoint is idempotent: if a row already exists for this user_id +
// image_url it does nothing further, so being hit twice for the same image
// yields exactly one gallery row and one total_generations increment.
//
// v133: userId is now taken from the verified JWT, not the body, so a caller
// can no longer write gallery rows onto someone else's account.

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireUser(req, res);
  if (!auth) return;
  const { userId, supabase } = auth;

  const { imageUrl, style, prompt, selectedModel } = req.body;
  if (!imageUrl) return res.status(400).json({ error: 'Missing imageUrl' });

  const modelKey = selectedModel || 'flux-pulid';

  // ── IDEMPOTENCY GUARD ──────────────────────────────────────────────────────
  const { data: existing } = await supabase
    .from('generations')
    .select('id')
    .eq('user_id', userId)
    .eq('image_url', imageUrl)
    .limit(1);

  if (existing && existing.length > 0) {
    const { data: profile } = await supabase
      .from('profiles').select('credits').eq('id', userId).single();
    return res.status(200).json({
      credits: profile?.credits,
      duplicate: true
    });
  }

  // ── RECORD THE GENERATION ──────────────────────────────────────────────────
  await supabase.from('generations').insert({
    user_id: userId,
    image_url: imageUrl,
    style: style || '',
    prompt: prompt || '',
    model: modelKey
  });

  // ── BUMP total_generations (credits are NOT touched here) ───────────────────
  const { data: profile } = await supabase
    .from('profiles').select('credits, total_generations').eq('id', userId).single();

  if (profile) {
    await supabase.from('profiles').update({
      total_generations: (profile.total_generations || 0) + 1
    }).eq('id', userId);
  }

  return res.status(200).json({
    credits: profile?.credits,
    model: modelKey
  });
}
