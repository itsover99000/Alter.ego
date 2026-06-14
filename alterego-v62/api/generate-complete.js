import { applyCors, requireUser } from '../lib/auth.js';

// ── /api/generate-complete ───────────────────────────────────────────────────
// Records a finished generation in the `generations` table and bumps
// total_generations. Handles BOTH images and (v139) animated videos via the
// `type` field:
//   type 'image' (default) → a still from /api/image
//   type 'video'           → a Kling animation; also stores source_image_url
//                            (which still it was animated from)
//
// It does NOT deduct credits — deduction happens atomically server-side in
// /api/image (images) and /api/animate (videos) BEFORE the fal call. Keeping
// deduction out of here makes deploy-overlap safe and keeps this endpoint a pure
// recorder.
//
// Idempotent: keyed on (user_id, image_url). Being hit twice for the same media
// yields exactly one row and one total_generations increment.
//
// Folding video recording in here (rather than a new endpoint) keeps us at 11
// Vercel functions — one slot still free under the 12 ceiling.

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireUser(req, res);
  if (!auth) return;
  const { userId, supabase } = auth;

  const { imageUrl, style, prompt, selectedModel, type, sourceImageUrl } = req.body;
  if (!imageUrl) return res.status(400).json({ error: 'Missing imageUrl' });

  const mediaType = type === 'video' ? 'video' : 'image';
  const modelKey = selectedModel || (mediaType === 'video' ? 'kling-v3-pro' : 'flux-pulid');

  // ── IDEMPOTENCY GUARD ──────────────────────────────────────────────────────
  // Keyed on the media URL (image_url holds the video URL for videos too).
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
  const row = {
    user_id: userId,
    image_url: imageUrl,
    style: style || '',
    prompt: prompt || '',
    model: modelKey,
    type: mediaType,
  };
  if (mediaType === 'video' && sourceImageUrl) {
    row.source_image_url = sourceImageUrl;
  }
  await supabase.from('generations').insert(row);

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
    model: modelKey,
    type: mediaType
  });
}
