export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const falKey = process.env.FAL_API_KEY;
  if (!falKey) return res.status(500).json({ error: { message: 'Fal API key not configured' } });

  try {
    const { prompt, imageBase64, mediaType, strongMods } = req.body;
    const imageDataUrl = imageBase64 ? `data:${mediaType || 'image/jpeg'};base64,${imageBase64}` : null;

    // Lower face lock strength when strong appearance mods are requested
    // 0.3 = prompt wins, 0.6 = face wins
    const faceStrength = strongMods ? 0.25 : 0.6;
    console.log(`strongMods: ${strongMods}, faceStrength: ${faceStrength}`);

    if (imageDataUrl) {
      console.log('Trying flux-pulid...');
      const pulidRes = await fetch('https://fal.run/fal-ai/flux-pulid', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Key ${falKey}`
        },
        body: JSON.stringify({
          prompt: prompt,
          reference_image_url: imageDataUrl,
          negative_prompt: "blurry, low quality, distorted, deformed, ugly",
          image_size: "portrait_4_3",
          num_inference_steps: 30,
          guidance_scale: strongMods ? 6.0 : 4.0,
          true_cfg: faceStrength,
          num_images: 1,
          enable_safety_checker: true
        })
      });

      const pulidData = await pulidRes.json();
      console.log('flux-pulid status:', pulidRes.status);
      console.log('flux-pulid response:', JSON.stringify(pulidData).slice(0, 300));

      if (pulidRes.ok && pulidData.images?.length > 0) {
        console.log('flux-pulid SUCCESS');
        return res.status(200).json({ images: pulidData.images, model: 'flux-pulid' });
      }
      if (pulidRes.ok && pulidData.image?.url) {
        return res.status(200).json({ images: [pulidData.image], model: 'flux-pulid' });
      }

      console.log('flux-pulid failed, falling back to Flux dev...');
    }

    // Flux fallback
    const fluxRes = await fetch('https://fal.run/fal-ai/flux/dev', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${falKey}`
      },
      body: JSON.stringify({
        prompt,
        image_size: 'portrait_4_3',
        num_inference_steps: 28,
        guidance_scale: 3.5,
        num_images: 1,
        enable_safety_checker: true
      })
    });

    const fluxData = await fluxRes.json();
    if (fluxData.images?.length > 0) return res.status(200).json({ images: fluxData.images, model: 'flux-fallback' });
    if (fluxData.image?.url) return res.status(200).json({ images: [fluxData.image], model: 'flux-fallback' });

    return res.status(500).json({
      images: null,
      error: { message: 'Both models failed: ' + JSON.stringify(Object.keys(fluxData)) }
    });

  } catch (err) {
    console.error('Exception:', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
}
