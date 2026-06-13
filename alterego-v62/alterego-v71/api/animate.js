import { createClient } from '@supabase/supabase-js';
import { applyCors, requireUser } from '../lib/auth.js';
import { ANIMATE_CREDIT_COST, creditBack, recordAnimateJob } from '../lib/animate-credits.js';

// Style-specific default animation prompts
const STYLE_PROMPTS = {
  cinematic:   'Gentle breathing, hair moves softly in wind, subtle camera push in. Hold face still. Cinematic motion.',
  cover:       'Subtle hair movement, soft light shifts, elegant atmosphere. Hold face still.',
  cyberpunk:   'Neon lights flicker and pulse, rain falls in background, holographic glitch effect. Hold face still.',
  anime:       'Hair strands flutter gently, sparkles drift through scene, soft atmospheric glow. Hold face still.',
  painterly:   'Candlelight flickers warmly, dust motes drift in soft light, gentle breathing. Hold face still.',
  campaign:    'Fabric moves gently in breeze, atmospheric light shifts, elegant slow camera drift. Hold face still.',
  'sci-fi':    'Holographic elements pulse and shimmer, particles drift in zero gravity, atmospheric haze. Hold face still.',
  streetwear:  'Urban atmosphere, light breeze moves clothing, city ambience, subtle camera drift. Hold face still.',
  headshot:    'Subtle breathing, soft light shift, professional calm atmosphere. Hold face still.',
  glamour:     'Soft light pulses gently, hair moves subtly, old Hollywood atmosphere. Hold face still.',
  acotar:      'Flames flicker and pulse with warm golden light, cloak ripples in wind, magical particles drift. Hold face still.',
  athlete:     'Stadium lights pulse, crowd blur moves in background, dramatic atmosphere. Hold face still.',
  warhol:      'Colours shift and pulse in pop art style, graphic elements animate. Hold face still.',
  riviera:     'Ocean breeze moves hair gently, light shimmers on water, golden hour atmosphere. Hold face still.',
  bohemian:    'Wildflowers sway in breeze, golden light shifts, dreamy atmospheric particles. Hold face still.',
  sovereign:   'Candlelight flickers dramatically, velvet fabric moves subtly, dust motes drift in regal light. Hold face still.',
};

const DEFAULT_PROMPT = 'Gentle breathing, subtle atmospheric movement, cinematic motion. Hold face still.';

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const falKey = process.env.FAL_API_KEY;
  if (!falKey) return res.status(500).json({ error: 'FAL_API_KEY not configured' });

  // ── AUTH ── userId from the verified JWT, not the body.
  const auth = await requireUser(req, res);
  if (!auth) return;
  const userId = auth.userId;

  const { imageUrl, style, animatePrompt, duration = '5' } = req.body;
  if (!imageUrl) return res.status(400).json({ error: 'Missing imageUrl' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // ── ATOMIC CREDIT DEDUCTION (race-safe) ───────────────────────────────────
  // v133: switched from read-then-write (which let two concurrent animate calls
  // both pass the check before either deducted) to the same atomic RPC image.js
  // uses. Deducts up front; we refund below if the Kling SUBMISSION fails, and
  // animate-poll refunds if the job later FAILS or times out.
  const { data: deductResult, error: deductErr } = await supabase
    .rpc('deduct_credits_if_available', { p_user_id: userId, p_cost: ANIMATE_CREDIT_COST });

  if (deductErr) {
    console.log('animate deduct error:', deductErr.message);
    return res.status(500).json({ error: 'Credit system error. Please try again.' });
  }
  // NULL/undefined => insufficient credits or lost race.
  if (deductResult === null || deductResult === undefined) {
    return res.status(402).json({
      error: `Animating costs ${ANIMATE_CREDIT_COST} credits — you don't have enough.`
    });
  }

  // Refund helper for the submission-failure paths below. These happen before
  // any pollable request_id exists, so a plain credit-back is safe (nothing for
  // the client to replay).
  const refund = async () => {
    try { await creditBack(supabase, userId); }
    catch (e) { console.log('animate refund error:', e.message); }
  };

  // ── Build prompt ──────────────────────────────────────────────────────────
  const prompt = animatePrompt || STYLE_PROMPTS[style?.toLowerCase()] || DEFAULT_PROMPT;
  const validDuration = ['5', '10'].includes(String(duration)) ? String(duration) : '5';

  console.log(`animate: style=${style}, duration=${validDuration}s, prompt=${prompt.slice(0, 80)}`);

  try {
    // ── Submit to Kling v3 Pro ────────────────────────────────────────────
    const submitRes = await fetch('https://fal.run/fal-ai/kling-video/v3/pro/image-to-video', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${falKey}`
      },
      body: JSON.stringify({
        start_image_url: imageUrl,
        prompt,
        duration: validDuration,
        generate_audio: false,
        cfg_scale: 0.5
      })
    });

    const submitData = await submitRes.json();
    console.log('kling submit status:', submitRes.status);

    if (!submitRes.ok) {
      await refund(); // submission rejected — give the credits back
      return res.status(500).json({
        error: submitData.detail || submitData.error || 'Kling submission failed',
        refunded: true
      });
    }

    // Credits were already deducted atomically up front.
    // Synchronous result:
    if (submitData.video?.url) {
      return res.status(200).json({ videoUrl: submitData.video.url });
    }

    // Async — return request_id for client polling.
    const requestId = submitData.request_id;
    if (!requestId) {
      await refund(); // nothing to poll — give the credits back
      return res.status(500).json({ error: 'Kling did not return a request ID', refunded: true });
    }

    // Record the job so animate-poll can refund it at most once if it later
    // FAILS or times out (replay protection).
    await recordAnimateJob(supabase, userId, requestId);

    return res.status(202).json({ requestId, status: 'processing' });

  } catch (err) {
    console.log('animate error:', err.message);
    await refund(); // exception before a pollable job existed — refund
    return res.status(500).json({ error: err.message, refunded: true });
  }
}
