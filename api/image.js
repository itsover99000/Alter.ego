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

    // Styles that need atmosphere over face accuracy → flux-pro
    // Styles that need face accuracy → flux-pulid first, flux-pro fallback
    const atmosphereStyles = ['cyberpunk', 'sci-fi', 'cinematic', 'anime', 'painterly'];
    const faceStyles = ['headshot', 'campaign', 'cover', 'glamour', 'streetwear'];
    const useAtmosphereModel = atmosphereStyles.includes(style);

    // Build prompt booster based on style type
    const skinDetail = 'natural skin texture, visible pores, subtle skin imperfections, film grain on skin, NOT smooth, NOT airbrushed, NOT plastic skin';

    const atmospherePrompt = `${prompt}, ${skinDetail}, NOT white background, NOT plain background, NOT studio backdrop`;
    const facePrompt = `hyper-realistic editorial photography, photorealistic, real person, tack sharp face, crisp facial detail, ${skinDetail}, ${prompt}, NOT white background, NOT plain background`;

    // ATMOSPHERE STYLES → flux-pro (style fidelity wins)
    if (useAtmosphereModel || !imageDataUrl) {
      console.log(`Style: ${style} → flux-pro (atmosphere mode)`);
      const fluxRes = await fetch('https://fal.run/fal-ai/flux-pro', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Key ${falKey}`
        },
        body: JSON.stringify({
          prompt: atmospherePrompt,
          negative_prompt: 'ugly, deformed, blurry, low quality, white background, plain background, studio white, watermark',
          image_size: 'portrait_4_3',
          num_inference_steps: 50,
          guidance_scale: 5.5,
          num_images: 1,
          enable_safety_checker: true
        })
      });

      const fluxData = await fluxRes.json();
      console.log('flux-pro status:', fluxRes.status);
      if (fluxData.images?.length > 0) return res.status(200).json({ images: fluxData.images });
      if (fluxData.image?.url) return res.status(200).json({ images: [fluxData.image] });
      return res.status(500).json({ error: { message: fluxData.detail || 'Generation failed' } });
    }

    // FACE STYLES → flux-pulid first (face accuracy wins), flux-pro fallback
    console.log(`Style: ${style} → flux-pulid (face mode)`);
    const pulidRes = await fetch('https://fal.run/fal-ai/flux-pulid', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${falKey}`
      },
      body: JSON.stringify({
        prompt: facePrompt,
        reference_image_url: imageDataUrl,
        negative_prompt: 'cartoon, illustration, anime, CGI, render, fake, plastic, low quality, blurry face, distorted face, ugly, deformed, white background, plain background',
        image_size: 'portrait_4_3',
        num_inference_steps: 50,
        guidance_scale: 5.0,
        true_cfg: 1.0,
        num_images: 1,
        enable_safety_checker: true
      })
    });

    const pulidData = await pulidRes.json();
    console.log('flux-pulid status:', pulidRes.status);

    if (pulidRes.ok && pulidData.images?.length > 0) return res.status(200).json({ images: pulidData.images });
    if (pulidRes.ok && pulidData.image?.url) return res.status(200).json({ images: [pulidData.image] });

    // Pulid failed — fall back to flux-pro
    console.log('flux-pulid failed, falling back to flux-pro...');
    const fallbackRes = await fetch('https://fal.run/fal-ai/flux-pro', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${falKey}`
      },
      body: JSON.stringify({
        prompt: facePrompt,
        negative_prompt: 'ugly, deformed, blurry, low quality, white background, plain background, watermark',
        image_size: 'portrait_4_3',
        num_inference_steps: 50,
        guidance_scale: 4.5,
        num_images: 1,
        enable_safety_checker: true
      })
    });

    const fallbackData = await fallbackRes.json();
    if (fallbackData.images?.length > 0) return res.status(200).json({ images: fallbackData.images });
    if (fallbackData.image?.url) return res.status(200).json({ images: [fallbackData.image] });

    return res.status(500).json({ error: { message: fallbackData.detail || 'Generation failed' } });

  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}
