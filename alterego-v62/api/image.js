import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const falKey = process.env.FAL_API_KEY;
  if (!falKey) return res.status(500).json({ error: { message: 'Fal API key not configured' } });

  try {
    const { prompt, imageBase64, mediaType, style, userId, selectedModel } = req.body;

    // ── THEME TIER ENFORCEMENT ────────────────────────────────────────
    const THEME_TIERS = {
      'pets': 'creator', 'st-moritz': 'creator', 'samurai': 'creator',
      'tennis': 'creator', 'cycling': 'creator', 'cyborg': 'creator', 'influencer': 'creator',
    };
    const TIER_RANK = { standard: 0, creator: 1, pro: 2 };

    if (style && THEME_TIERS[style]) {
      const supabaseCheck = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data: profileCheck } = await supabaseCheck
        .from('profiles').select('model_tier, unlocked_models').eq('id', userId).single();
      const userTier = profileCheck?.model_tier || 'standard';
      const userUnlocked = profileCheck?.unlocked_models || [];
      // Beta override must be theme-specific: only the exact theme keys present
      // in the user's unlocked_models bypass the tier gate. "has unlocked
      // anything" would leak every Creator theme to every beta tester.
      const themeUnlockedByCode = userUnlocked.includes(style);
      const requiredRank = TIER_RANK[THEME_TIERS[style]] ?? 1;
      const userRank = TIER_RANK[userTier] ?? 0;
      if (!themeUnlockedByCode && userRank < requiredRank) {
        return res.status(403).json({ error: 'This theme requires a Creator or Pro account. Upgrade to unlock.' });
      }
    }

    // ── CREDIT CHECK BEFORE GENERATION ──────────────────────────────
    if (userId) {
      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
      );
      const { data: profile } = await supabase
        .from('profiles').select('credits').eq('id', userId).single();
      if (!profile || profile.credits <= 0) {
        return res.status(402).json({ error: { message: 'No credits remaining. Please purchase more to continue.' } });
      }
    }

    const skinDetail = 'natural skin texture, visible pores, subtle skin imperfections, film grain on skin, NOT smooth, NOT airbrushed, NOT plastic skin';
    const noBranding = 'no text on clothing, no logos, no brand names, no graphic tees, no printed text, no writing on clothes';
    const noBackground = 'NOT white background, NOT plain background, NOT studio backdrop';

    // id_weight controls face lock strength (0-1)
    // High = strong face lock, may limit environment complexity
    // Low = looser face match, environment renders more freely
    const idWeightByStyle = {
      // Tight face lock — portrait styles
      headshot:   1.0,
      cover:      0.9,
      glamour:    0.9,
      campaign:   0.85,
      // Medium face lock — editorial/street, face matters but so does scene
      editorial:  0.8,
      streetwear: 0.75,
      athlete:    0.75,
      // Loose face lock — atmosphere styles, scene is the hero
      cinematic:  0.65,
      cyberpunk:  0.60,
      'sci-fi':   0.60,
      anime:      0.55,
      painterly:  0.50,
      // Fantasy/stylised — loose face, world is the hero
      acotar:     0.60,
      // Warhol — very loose, graphic treatment dominates
      warhol:     0.60,
      // Previously missing styles
      riviera:    0.70,
      bohemian:   0.65,
      sovereign:  0.65,
      // Pets — LOW id_weight on purpose. PuLID is trained on human faces;
      // a high weight forces human facial geometry onto an animal muzzle
      // (humanisation drift). Low weight lets the prompt's animal anatomy win
      // while still carrying the pet's colouring/markings from the reference.
      pets:       0.50,
    };

    const idWeight = idWeightByStyle[style] ?? 0.75;
    console.log(`Style: ${style} → flux-pulid id_weight: ${idWeight}`);

    const fullPrompt = `${prompt}, ${skinDetail}, ${noBackground}`;
    const negativePrompt = `cartoon, illustration, CGI, render, fake, plastic, low quality, blurry face, distorted face, ugly, deformed, white background, plain background, ${noBranding}, watermark`;

    // ── NANABANA + FACE SWAP PIPELINE ───────────────────────────────
    // Step 1: Generate with nano-banana-pro (muapi) for high quality
    // Step 2: Swap selfie face onto the generated image (fal face swap)
    if (selectedModel === 'nano-faceswap' && imageBase64) {
      const falImageUrl = `data:${mediaType || 'image/jpeg'};base64,${imageBase64}`;

      try {
        console.log('nano-faceswap: step 1 — generating with nano-banana-pro');

        // Step 1: Generate with fal-ai/nano-banana-2 (fal infrastructure)
        console.log('nano-faceswap: step 1 — fal nano-banana-2');
        const nbRes = await fetch('https://fal.run/fal-ai/nano-banana-2', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Key ${falKey}` },
          body: JSON.stringify({ prompt: fullPrompt, aspect_ratio: '3:4', resolution: '1K' })
        });
        const nbData = await nbRes.json();
        console.log('nano-banana-2 status:', nbRes.status);

        const generatedImageUrl = nbData.images?.[0]?.url || nbData.image?.url;
        if (!nbRes.ok || !generatedImageUrl) {
          throw new Error('NanaBana 2 generation failed: ' + JSON.stringify(nbData).slice(0, 200));
        }
        console.log('nano-faceswap: step 1 complete, got image URL');

        // Step 2: Face swap — put selfie face onto generated image
        console.log('nano-faceswap: step 2 — face swap');
        const swapRes = await fetch('https://fal.run/easel-ai/advanced-face-swap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Key ${falKey}` },
          body: JSON.stringify({
            face_image_0: falImageUrl,
            target_image: generatedImageUrl,
            workflow_type: 'user_hair'
          })
        });
        const swapData = await swapRes.json();
        console.log('face-swap status:', swapRes.status);

        const swapUrl = swapData.image?.url || swapData.images?.[0]?.url;
        if (swapRes.ok && swapUrl) {
          console.log('nano-faceswap: pipeline complete');
          return res.status(200).json({ images: [{ url: swapUrl }] });
        }
        console.log('face-swap failed:', JSON.stringify(swapData).slice(0, 300));
        // Fall through to PuLID if face swap fails
      } catch (pipelineErr) {
        console.log('nano-faceswap pipeline error:', pipelineErr.message);
        // Fall through to PuLID
      }
    }

    // ── FLUX-PULID ───────────────────────────────────────────────────
    // fal.ai natively supports base64 data URIs as image input —
    // no CDN upload needed. Pass data URI directly to PuLID.
    const falImageUrl = imageBase64
      ? `data:${mediaType || 'image/jpeg'};base64,${imageBase64}`
      : null;

    if (falImageUrl) {
      let pulidData = null;
      let pulidStatus = null;

      try {
        const pulidRes = await fetch('https://fal.run/fal-ai/flux-pulid', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Key ${falKey}`
          },
          body: JSON.stringify({
            prompt: fullPrompt,
            reference_image_url: falImageUrl,
            negative_prompt: negativePrompt,
            image_size: 'portrait_4_3',
            num_inference_steps: 28,          // reduced from 50 — fits Vercel 10s limit
            guidance_scale: style === 'headshot' || style === 'cover' ? 4.5 : 5.5,
            id_weight: idWeight,
            true_cfg: 1.0,
            num_images: 1,
            enable_safety_checker: true
          })
        });

        pulidStatus = pulidRes.status;
        pulidData = await pulidRes.json();

        // Detailed error logging so we can see actual PuLID failures in Vercel logs
        if (!pulidRes.ok) {
          console.log('flux-pulid FAILED:', pulidStatus, JSON.stringify(pulidData).slice(0, 400));
        } else {
          console.log('flux-pulid OK:', pulidStatus);
        }

        if (pulidRes.ok && pulidData.images?.length > 0) return res.status(200).json({ images: pulidData.images });
        if (pulidRes.ok && pulidData.image?.url) return res.status(200).json({ images: [pulidData.image] });

      } catch (pulidErr) {
        console.log('flux-pulid exception:', pulidErr.message);
      }

      console.log('flux-pulid did not return images — falling back to flux-pro');
    } else {
      console.log('No fal CDN URL — skipping PuLID, going straight to flux-pro fallback');
    }

    // ── FALLBACK: FLUX-PRO ───────────────────────────────────────────
    console.log(`Fallback: flux-pro for style ${style}`);
    const fluxRes = await fetch('https://fal.run/fal-ai/flux-pro', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${falKey}`
      },
      body: JSON.stringify({
        prompt: fullPrompt,
        negative_prompt: `ugly, deformed, blurry, low quality, white background, plain background, ${noBranding}, watermark`,
        image_size: 'portrait_4_3',
        num_inference_steps: 28,              // reduced from 50
        guidance_scale: 5.5,
        num_images: 1,
        enable_safety_checker: true
      })
    });

    const fluxData = await fluxRes.json();
    if (!fluxRes.ok) {
      console.log('flux-pro FAILED:', fluxRes.status, JSON.stringify(fluxData).slice(0, 400));
    }

    if (fluxData.images?.length > 0) return res.status(200).json({ images: fluxData.images });
    if (fluxData.image?.url) return res.status(200).json({ images: [fluxData.image] });

    return res.status(500).json({ error: { message: fluxData.detail || 'Generation failed' } });

  } catch (err) {
    console.log('api/image.js top-level error:', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
}
