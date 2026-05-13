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

      // Log full response for debugging
      console.log('InstantID response keys:', Object.keys(data));
      console.log('InstantID response:', JSON.stringify(data).slice(0, 500));

      // Handle different response shapes from fal.ai
      // Shape 1: { images: [{url: ...}] }
      if (data.images && data.images.length > 0) {
        return res.status(200).json({ images: data.images });
      }
      // Shape 2: { image: {url: ...} }
      if (data.image && data.image.url) {
        return res.status(200).json({ images: [data.image] });
      }
      // Shape 3: { output: {images: [...]} }
      if (data.output && data.output.images) {
        return res.status(200).json({ images: data.output.images });
      }
      // Shape 4: direct url string
      if (data.url) {
        return res.status(200).json({ images: [{ url: data.url }] });
      }

      // Return raw data so frontend can log it
      return res.status(200).json({ 
        images: null, 
        debug: data,
        error: { message: 'Unexpected response format: ' + JSON.stringify(Object.keys(data)) }
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
