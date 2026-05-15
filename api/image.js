export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const falKey = process.env.FAL_API_KEY;
  if (!falKey) return res.status(500).json({ error: { message: 'Fal API key not configured' } });

  try {
    const { prompt, imageBase64, mediaType, style } = req.body;
    const imageDataUrl = imageBase64 ? `data:${mediaType || 'image/jpeg'};base64,${imageBase64}` : null;

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
      // Loose face lock — atmosphere styles, scene is the hero
      cinematic:  0.65,
      cyberpunk:  0.60,
      'sci-fi':   0.60,
      anime:      0.55,
      painterly:  0.50,
    };

    const idWeight = idWeightByStyle[style] ?? 0.75;
    console.log(`Style: ${style} → flux-pulid id_weight: ${idWeight}`);

    const fullPrompt = `${prompt}, ${skinDetail}, ${noBackground}`;
    const negativePrompt = `cartoon, illustration, CGI, render, fake, plastic, low quality, blurry face, distorted face, ugly, deformed, white background, plain background, ${noBranding}, watermark`;

    // All styles go through flux-pulid with tuned id_weight
    if (imageDataUrl) {
      const pulidRes = await fetch('https://fal.run/fal-ai/flux-pulid', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Key ${falKey}`
        },
        body: JSON.stringify({
          prompt: fullPrompt,
          reference_image_url: imageDataUrl,
          negative_prompt: negativePrompt,
          image_size: 'portrait_4_3',
          num_inference_steps: 50,
          guidance_scale: style === 'headshot' || style === 'cover' ? 4.5 : 5.5,
          id_weight: idWeight,
          true_cfg: 1.0,
          num_images: 1,
          enable_safety_checker: true
        })
      });

      const pulidData = await pulidRes.json();
      console.log('flux-pulid status:', pulidRes.status, pulidData.detail || '');

      if (pulidRes.ok && pulidData.images?.length > 0) return res.status(200).json({ images: pulidData.images });
      if (pulidRes.ok && pulidData.image?.url) return res.status(200).json({ images: [pulidData.image] });

      console.log('flux-pulid failed — falling back to flux-pro');
    }

    // Fallback: flux-pro (no face reference, pure prompt)
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
        num_inference_steps: 50,
        guidance_scale: 5.5,
        num_images: 1,
        enable_safety_checker: true
      })
    });

    const fluxData = await fluxRes.json();
    if (fluxData.images?.length > 0) return res.status(200).json({ images: fluxData.images });
    if (fluxData.image?.url) return res.status(200).json({ images: [fluxData.image] });

    return res.status(500).json({ error: { message: fluxData.detail || 'Generation failed' } });

  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}
