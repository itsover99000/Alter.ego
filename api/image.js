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

    if (imageBase64) {
      const imageDataUrl = `data:${mediaType || 'image/jpeg'};base64,${imageBase64}`;

      const response = await fetch('https://fal.run/fal-ai/flux-pulid', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Key ${falKey}`
        },
        body: JSON.stringify({
          reference_images: [{ image_url: imageDataUrl }],
          prompt: prompt,
          negative_prompt: "oversaturated, neon colors, psychedelic, distorted, low quality, blurry, deformed face, bad anatomy, watermark",
          num_inference_steps: 20,
          guidance_scale: 4,
          true_cfg: 1,
          id_weight: 1.0,
          image_size: "portrait_4_3",
          num_images: 1,
          enable_safety_checker: true
        })
      });

      const data = await response.json();
      console.log('PuLID response:', JSON.stringify(data).slice(0, 300));

      if (data.images && data.images.length > 0) {
        return res.status(200).json({ images: data.images });
      }
      if (data.image && data.image.url) {
        return res.status(200).json({ images: [data.image] });
      }

      return res.status(200).json({
        images: null,
        error: { message: 'No image: ' + JSON.stringify(Object.keys(data)) }
      });

    } else {
      const response = await fetch('https://fal.run/fal-ai/flux/dev', {
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

      const data = await response.json();
      return res.status(response.status).json(data);
    }

  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}
