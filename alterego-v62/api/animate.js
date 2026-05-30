import { createClient } from '@supabase/supabase-js';

const ANIMATE_CREDIT_COST = 8; // ~$0.56 for 5s Kling v3 Pro

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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const falKey = process.env.FAL_API_KEY;
  if (!falKey) return res.status(500).json({ error: 'FAL_API_KEY not configured' });

  const { userId, imageUrl, style, animatePrompt, duration = '5' } = req.body;
  if (!userId || !imageUrl) return res.status(400).json({ error: 'Missing userId or imageUrl' });

  // ── Credit check ─────────────────────────────────────────────────────────
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const { data: profile } = await supabase
    .from('profiles').select('credits').eq('id', userId).single();

  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  if (profile.credits < ANIMATE_CREDIT_COST) {
    return res.status(402).json({
      error: `Animating costs ${ANIMATE_CREDIT_COST} credits. You have ${profile.credits}.`
    });
  }

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
      return res.status(500).json({
        error: submitData.detail || submitData.error || 'Kling submission failed'
      });
    }

    // Check if synchronous result
    if (submitData.video?.url) {
      // Deduct credits
      await supabase.from('profiles')
        .update({ credits: profile.credits - ANIMATE_CREDIT_COST })
        .eq('id', userId);

      return res.status(200).json({ videoUrl: submitData.video.url });
    }

    // Async — return request_id for client polling
    const requestId = submitData.request_id;
    if (!requestId) {
      return res.status(500).json({ error: 'Kling did not return a request ID' });
    }

    // Deduct credits on submission
    await supabase.from('profiles')
      .update({ credits: profile.credits - ANIMATE_CREDIT_COST })
      .eq('id', userId);

    return res.status(202).json({ requestId, status: 'processing' });

  } catch (err) {
    console.log('animate error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
