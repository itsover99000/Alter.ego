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
    const { prompt, imageBase64, mediaType, style, userId } = req.body;

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
    };

    const idWeight = idWeightByStyle[style] ?? 0.75;
    console.log(`Style: ${style} → flux-pulid id_weight: ${idWeight}`);

    const fullPrompt = `${prompt}, ${skinDetail}, ${noBackground}`;
    const negativePrompt = `cartoon, illustration, CGI, render, fake, plastic, low quality, blurry face, distorted face, ugly, deformed, white background, plain background, ${noBranding}, watermark`;

    // ── FAL CDN UPLOAD ───────────────────────────────────────────────
    // Upload base64 image to fal storage first — avoids sending large
    // data URIs in the PuLID payload and prevents Vercel timeout issues
    let falImageUrl = null;
    if (imageBase64) {
      try {
        const mimeType = mediaType || 'image/jpeg';
        const buffer = Buffer.from(imageBase64, 'base64');
        const blob = new Blob([buffer], { type: mimeType });
        const ext = mimeType.includes('png') ? 'png' : 'jpg';

        const formData = new FormData();
        formData.append('file', blob, `selfie.${ext}`);

        const uploadRes = await fetch('https://fal.run/storage/upload', {
          method: 'POST',
          headers: { 'Authorization': `Key ${falKey}` },
          body: formData
        });

        const uploadData = await uploadRes.json();
        if (uploadRes.ok && uploadData.url) {
          falImageUrl = uploadData.url;
          console.log('fal CDN upload OK:', falImageUrl);
        } else {
          console.log('fal CDN upload failed:', JSON.stringify(uploadData));
        }
      } catch (uploadErr) {
        console.log('fal CDN upload error:', uploadErr.message);
      }
    }

    // ── FLUX-PULID ───────────────────────────────────────────────────
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
