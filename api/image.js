export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const falKey = process.env.FAL_API_KEY;
  if (!falKey) return res.status(500).json({ error: { message: 'Fal API key not configured' } });

  try {
    const { prompt, imageBase64, mediaType } = req.body;
    const imageDataUrl = imageBase64 ? `data:${mediaType || 'image/jpeg'};base64,${imageBase64}` : null;

    // Prepend realism booster to every prompt
    const realisticPrompt = `hyper-realistic editorial photography, photorealistic, real person, full body sharp focus head to toe, tack sharp face, crisp facial detail, natural skin texture, visible pores, subtle skin imperfections, realistic complexion, film grain on skin, ${prompt}, NOT a painting, NOT illustration, NOT cartoon, NOT CGI, NOT over-retouched, NOT plastic skin, NOT smooth AI skin, NOT blurry face, NOT soft focus face, NOT white background, NOT plain background, NOT studio white, NOT blank background`;

    if (imageDataUrl) {
      console.log('Trying flux-pulid...');
      const pulidRes = await fetch('https://fal.run/fal-ai/flux-pulid', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Key ${falKey}`
        },
        body: JSON.stringify({
          prompt: realisticPrompt,
          reference_image_url: imageDataUrl,
          negative_prompt: "cartoon, illustration, painting, drawing, anime, CGI, render, fake, plastic, low quality, blurry face, soft face, out of focus face, distorted face, ugly, deformed",
          image_size: "portrait_4_3",
          num_inference_steps: 50,
          guidance_scale: 5.0,
          true_cfg: 1.0,
          num_images: 1,
          enable_safety_checker: true
        })
      });

      const pulidData = await pulidRes.json();
      console.log('flux-pulid status:', pulidRes.status);

      if (pulidRes.ok && pulidData.images?.length > 0) {
        console.log('flux-pulid SUCCESS');
        return res.status(200).json({ images: pulidData.images });
      }
      if (pulidRes.ok && pulidData.image?.url) {
        return res.status(200).json({ images: [pulidData.image] });
      }
      console.log('flux-pulid failed, falling back to flux-pro...');
    }

    // Flux Pro fallback — sharper detail than flux/dev, better face quality at distance
    const fluxRes = await fetch('https://fal.run/fal-ai/flux-pro', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${falKey}`
      },
      body: JSON.stringify({
        prompt: realisticPrompt,
        negative_prompt: "cartoon, illustration, painting, drawing, anime, CGI, render, fake, blurry face, soft focus, distorted",
        image_size: 'portrait_4_3',
        num_inference_steps: 50,
        guidance_scale: 4.5,
        num_images: 1,
        enable_safety_checker: true
      })
    });

    const fluxData = await fluxRes.json();
    if (fluxData.images?.length > 0) return res.status(200).json({ images: fluxData.images });
    if (fluxData.image?.url) return res.status(200).json({ images: [fluxData.image] });

    return res.status(500).json({
      images: null,
      error: { message: fluxData.detail || 'Generation failed' }
    });

  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}
