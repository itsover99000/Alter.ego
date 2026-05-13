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

    // If we have a face image, use InstantID for face-locked generation
    if (imageBase64) {
      const imageDataUrl = `data:${mediaType || 'image/jpeg'};base64,${imageBase64}`;

      const response = await fetch('https://fal.run/fal-ai/instantid', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Key ${falKey}`
        },
        body: JSON.stringify({
          face_image_url: imageDataUrl,
          prompt: prompt,
          negative_prompt: "blurry, low quality, distorted face, deformed, ugly, bad anatomy",
          num_inference_steps: 30,
          guidance_scale: 5,
          image_size: "portrait_4_3",
          num_images: 1,
          enable_safety_checker: true
        })
      });

      const data = await response.json();

      // InstantID returns images array directly
      if (data.images) {
        return res.status(200).json({ images: data.images });
      }

      // If InstantID fails, fall back to Flux
      console.log('InstantID response:', JSON.stringify(data).slice(0, 200));
      return res.status(response.status).json(data);

    } else {
      // No face image — fall back to plain Flux
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
