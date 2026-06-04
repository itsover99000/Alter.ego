import { createClient } from '@supabase/supabase-js';

// ── /api/generate-complete ───────────────────────────────────────────────────
// Records a finished generation in the gallery (generations table) and bumps
// total_generations. It does NOT deduct credits — credit deduction now happens
// atomically, server-side, in /api/image BEFORE the fal call (see image.js and
// DEPLOY_credit_race_fix.sql). Keeping deduction out of here is what makes the
// deploy overlap safe: an old cached client that still calls this endpoint can
// no longer double-charge, because this endpoint never touches credits.
//
// This endpoint is idempotent: if a row already exists for this user_id +
// image_url it does nothing further, so being hit twice for the same image
// (e.g. an old and a new client during the deploy window) yields exactly one
// gallery row and one total_generations increment.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { userId, imageUrl, style, prompt, selectedModel } = req.body;
  if (!userId || !imageUrl) return res.status(400).json({ error: 'Missing fields' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const modelKey = selectedModel || 'flux-pulid';

  // ── IDEMPOTENCY GUARD ──────────────────────────────────────────────────────
  // fal image URLs are unique per generation, so (user_id, image_url) reliably
  // identifies a single generation. If it's already recorded, return early —
  // no duplicate gallery row, no double increment.
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
