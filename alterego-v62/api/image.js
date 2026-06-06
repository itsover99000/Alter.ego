import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const falKey = process.env.FAL_API_KEY;
  if (!falKey) return res.status(500).json({ error: { message: 'Fal API key not configured' } });

  // Credit-deduction state hoisted to function scope so BOTH the try-body and
  // the catch block can refund on a total failure (an exception thrown after we
  // deducted but before any image returned must still refund).
  let creditDeducted = false;
  let creditCost = 1;
  let newCreditBalance = null;
  let creditSupabase = null;
  let creditUserId = null;

  const refundCredit = async () => {
    if (!creditDeducted || !creditSupabase || !creditUserId) return;
    try {
      const { data: p } = await creditSupabase
        .from('profiles').select('credits').eq('id', creditUserId).single();
      if (p) {
        await creditSupabase.from('profiles')
          .update({ credits: (p.credits || 0) + creditCost })
          .eq('id', creditUserId);
        console.log(`image.js: refunded ${creditCost} credit(s) to ${creditUserId} after total generation failure`);
      }
    } catch (e) {
      console.log('image.js refund error:', e.message);
    }
  };

  try {
    const { prompt, imageBase64, mediaType, style, userId, selectedModel, petGender } = req.body;

    // ── THEME TIER ENFORCEMENT ────────────────────────────────────────
    const THEME_TIERS = {
      'pets': 'creator', 'st-moritz': 'creator', 'samurai': 'creator',
      'cyborg': 'creator', 'old-money': 'creator',
      'dark-academia': 'creator', 'western': 'creator',
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

    // ── ATOMIC CREDIT DEDUCTION BEFORE GENERATION ───────────────────
    // The credit is deducted HERE, server-side, before the fal call — not in a
    // separate client-triggered /api/generate-complete call. This closes two
    // leaks: (1) concurrent requests can no longer all pass a read-only check
    // before any deducts, and (2) a client that never calls generate-complete
    // can no longer generate for free.
    //
    // Atomicity comes from the Postgres function deduct_credits_if_available,
    // which does check-and-decrement in a single locked statement and returns
    // the new balance, or NULL when the balance is insufficient / the race was
    // lost. The .rpc() call runs SERVER-SIDE with the service key (compliant
    // with the no-client-DB rule — the rule forbids sb.from()/sb.rpc() in the
    // browser, not on the server).
    //
    // REQUIRES the SQL function to exist — run DEPLOY_credit_race_fix.sql in
    // Supabase BEFORE deploying this code, or every generation will fail.
    //
    // creditCost is read once into a single variable so the deduct amount and
    // the later refund amount can never drift apart.
    creditUserId = userId || null;

    if (userId) {
      creditSupabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
      );

      // Per-model credit cost, defaulting hard to 1. Future-proofs paid models /
      // a multi-credit Pets without reintroducing a hardcoded magic number.
      const resolvedModel = selectedModel || 'flux-pulid';
      try {
        const { data: modelRecord } = await creditSupabase
          .from('models').select('credit_cost').eq('key', resolvedModel).eq('active', true).single();
        if (modelRecord && Number.isFinite(modelRecord.credit_cost)) {
          creditCost = modelRecord.credit_cost;
        }
      } catch (e) {
        console.log('credit_cost lookup failed, defaulting to 1:', e.message);
      }
      if (!Number.isFinite(creditCost) || creditCost < 1) creditCost = 1;

      // Atomic check-and-decrement. Returns new balance on success, NULL if declined.
      const { data: rpcResult, error: rpcErr } = await creditSupabase
        .rpc('deduct_credits_if_available', { p_user_id: userId, p_cost: creditCost });

      if (rpcErr) {
        console.log('deduct_credits_if_available error:', rpcErr.message);
        return res.status(500).json({ error: { message: 'Credit system error. Please try again.' } });
      }

      // NULL (or no value) => guard failed: insufficient credits / lost the race.
      // A real number (including 0) => the deduction applied.
      if (rpcResult === null || rpcResult === undefined) {
        return res.status(402).json({ error: { message: 'No credits remaining. Please purchase more to continue.' } });
      }

      creditDeducted = true;
      newCreditBalance = Number(rpcResult);
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
      // Pets — moderate-high id_weight. PuLID is trained on human faces, so very
      // high values force human facial geometry onto an animal muzzle (humanisation
      // drift). But the prompts now strongly enforce four-legged / non-anthropomorphic,
      // which lets us push higher for better pet likeness without as much drift.
      // 0.62 = closer match to the actual pet's face/markings while resisting humanising.
      // Levers: drop toward 0.55 if faces start looking human; raise toward 0.68 if
      // markings/likeness still too generic.
      pets:       0.62,
      'old-money': 0.65,
      'dark-academia': 0.65,
      western:    0.65,
      // Cyborg — was falling through to the 0.75 default, which locked the human
      // face too hard and resisted the mechanical augmentation (chrome plating,
      // circuitry, implants) fusing onto it. 0.55 keeps the face recognisable while
      // giving the machinery room to render. Lever: raise toward 0.62 if faces drift
      // off-likeness; drop toward 0.50 if the mechanical detail still reads too subtle.
      cyborg:     0.55,
    };

    const idWeight = idWeightByStyle[style] ?? 0.75;
    console.log(`Style: ${style} → flux-pulid id_weight: ${idWeight}`);

    const fullPrompt = `${prompt}, ${skinDetail}, ${noBackground}`;
    const negativePrompt = `cartoon, illustration, CGI, render, fake, plastic, low quality, blurry face, distorted face, ugly, deformed, white background, plain background, ${noBranding}, watermark`;

    // ── PETS — DEDICATED IMAGE-EDIT PATH (nano-banana-2/edit) ────────
    // Pets must keep the ACTUAL animal — exact coat colour, muzzle colour,
    // and every marking from the user's photo. Face-ID (PuLID) and face-swap
    // both fail at this: PuLID humanises animal faces, face-swap only swaps the
    // face region and re-colours the coat/muzzle from the generated target.
    // An instruction-edit model edits the SCENE around the preserved subject,
    // so the dog's real markings survive. This branch is Pets-only; human
    // themes are completely untouched below.
    if (style === 'pets' && imageBase64) {
      const petImageUrl = `data:${mediaType || 'image/jpeg'};base64,${imageBase64}`;
      // The styleDescriptions prompt describes the regal scene/wardrobe; we wrap
      // it as an EDIT instruction that prioritises preserving the animal exactly.
      // Gender styling: the model can't tell a dog's sex from a photo, so the user
      // tells us. When set, steer the regal styling male/female with VISIBLE regalia
      // (the model cannot read sex from a clothed seated dog, so gender must be carried
      // by renderable styling cues, not the word alone).
      // King/Queen styling choice (a styling register, not a biological-sex claim —
      // sex cannot be reliably rendered on a clothed seated dog, so we offer the
      // aesthetic the model CAN deliver: kingly vs queenly regalia and bearing).
      const genderClause = petGender === 'male'
        ? ' Style this as a KING portrait — distinctly masculine, kingly regalia: a bold crown or coronet, a deep crimson, navy or forest-green velvet cape with gold trim and fur-lined collar, a heavy ornate medallion or chain-of-office, a sturdy jewelled collar with strong squared settings; a strong, broad, commanding bearing, a king or prince register.'
        : petGender === 'female'
        ? ' Style this as a QUEEN portrait — distinctly feminine, queenly styling: render a soft, gentle, refined and delicately graceful expression (while keeping the exact same breed, fur colour and every marking faithfully preserved), dressed in a delicate jewelled tiara, a rich jewel-tone velvet cape or robe (deep crimson, burgundy, emerald or sapphire) with gold or silver trim and elegant detailing, a dainty pearl-and-gem necklace and pearl detailing, a slender collar with rounded settings; elegant graceful regal bearing, a queen or princess register.'
        : ' Use elegant gender-neutral regal styling.';

      const editInstruction =
        `Keep the exact same animal from the photo with its precise breed, face, ` +
        `fur colour, muzzle colour, eye colour and every marking and pattern ` +
        `completely unchanged and faithfully preserved — do not alter the animal's ` +
        `coat or features in any way.` + genderClause + ` Only restyle the surroundings, wardrobe and ` +
        `lighting: ${prompt}.` + ` The animal must remain a true ` +
        `four-legged animal in a natural pose, photorealistic, not anthropomorphic.`;

      try {
        console.log('pets: nano-banana-2/edit — preserving animal, restyling scene');
        const editRes = await fetch('https://fal.run/fal-ai/nano-banana-2/edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Key ${falKey}` },
          body: JSON.stringify({
            prompt: editInstruction,
            image_urls: [petImageUrl],
            aspect_ratio: '3:4',
            resolution: '1K',
            num_images: 1
          })
        });
        const editData = await editRes.json();
        console.log('pets nano-banana-2/edit status:', editRes.status);

        const editUrl = editData.images?.[0]?.url || editData.image?.url;
        if (editRes.ok && editUrl) {
          console.log('pets: edit complete — markings preserved');
          return res.status(200).json({ images: [{ url: editUrl }], credits: newCreditBalance });
        }
        console.log('pets edit failed, falling through to PuLID:', JSON.stringify(editData).slice(0, 300));
        // Fall through to PuLID below if the edit path fails — Pets never hard-breaks.
      } catch (petErr) {
        console.log('pets edit exception, falling through to PuLID:', petErr.message);
      }
    }

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
          return res.status(200).json({ images: [{ url: swapUrl }], credits: newCreditBalance });
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
            guidance_scale: style === 'headshot' || style === 'cover' ? 4.5 : (style === 'pets' ? 6.5 : 5.5),
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

        if (pulidRes.ok && pulidData.images?.length > 0) return res.status(200).json({ images: pulidData.images, credits: newCreditBalance });
        if (pulidRes.ok && pulidData.image?.url) return res.status(200).json({ images: [pulidData.image], credits: newCreditBalance });

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

    if (fluxData.images?.length > 0) return res.status(200).json({ images: fluxData.images, credits: newCreditBalance });
    if (fluxData.image?.url) return res.status(200).json({ images: [fluxData.image], credits: newCreditBalance });

    // Total failure — the entire chain (PuLID → flux-pro) returned no image.
    // Refund the credit we deducted up front, then report the failure.
    await refundCredit();
    return res.status(500).json({ error: { message: fluxData.detail || 'Generation failed' }, refunded: creditDeducted });

  } catch (err) {
    console.log('api/image.js top-level error:', err.message);
    // An exception after deduction but before any image returned must refund.
    await refundCredit();
    return res.status(500).json({ error: { message: err.message }, refunded: creditDeducted });
  }
}
