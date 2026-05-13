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

    if (imageDataUrl) {
      console.log('Trying flux-pulid with full face lock...');
      const pulidRes = await fetch('https://fal.run/fal-ai/flux-pulid', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Key ${falKey}`
        },
        body: JSON.stringify({
          prompt,
          reference_image_url: imageDataUrl,
          negative_prompt: "blurry, low quality, distorted, deformed, ugly, bad likeness",
          image_size: "portrait_4_3",
          num_inference_steps: 35,
          guidance_scale: 4.5,
          true_cfg: 1.0,
          num_images: 1,
          enable_safety_checker: true
        })
      });

      const pulidData = await pulidRes.json();
      console.log('flux-pulid status:', pulidRes.status);
      console.log('flux-pulid response:', JSON.stringify(pulidData).slice(0, 300));

      if (pulidRes.ok && pulidData.images?.length > 0) {
        console.log('flux-pulid SUCCESS');
        return res.status(200).json({ images: pulidData.images });
      }
      if (pulidRes.ok && pulidData.image?.url) {
        return res.status(200).json({ images: [pulidData.image] });
      }

      console.log('flux-pulid failed, falling back to Flux...');
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
        num_inference_steps: 35,
        guidance_scale: 4.0,
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
