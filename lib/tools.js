export async function generateImage(prompt, config) {
  const model = config?.IMAGE_MODEL || 'x/flux2-klein:9b';
  const host = config?.OLLAMA_HOST || '127.0.0.1';
  const port = config?.OLLAMA_PORT || '11434';
  
  const response = await fetch(`http://${host}:${port}/api/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model,
      prompt: prompt,
      stream: false, // Set to false to get a single JSON object back
      options: {
        num_predict: 4, // If using the Distilled model variant
        temperature: 0.7
      }
    }),
  });

  const data = await response.json();
  // Ollama returns images as base64 strings in the 'response', 'images' array, or 'image' field
  const base64Image = data.response || data.image || (data.images && data.images[0]);
  
  if (!base64Image) {
    console.error('[TOOLS] Missing image data. Full response:', data);
    throw new Error(`No image data returned from generator. Response: ${JSON.stringify(data)}`);
  }

  // Return the Markdown formatted image!
  return `\n\n![Generated Image](data:image/jpeg;base64,${base64Image.trim()})\n\n`;
}

// 1. Create a lookup object
export const availableFunctions = {
  generate_image: generateImage
};

// 2. Helper to execute the tool calls
export async function executeToolCalls(toolCalls, config) {
  let combinedMarkdown = '';
  
  for (const call of toolCalls) {
    const functionToCall = availableFunctions[call.function.name];
    
    if (functionToCall) {
      let args = call.function.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch(e) {}
      }
      
      try {
        console.log(`[TOOLS] Executing ${call.function.name} with prompt:`, args.prompt);
        // 3. Execute the function with the model's suggested arguments
        const resultMarkdown = await functionToCall(args.prompt, config);
        console.log(`[TOOLS] Image generated successfully!`);
        combinedMarkdown += resultMarkdown;
      } catch (err) {
        console.error(`[TOOLS] Error generating image:`, err);
        combinedMarkdown += `\n\n*(Error generating image: ${err.message})*\n\n`;
      }
    }
  }
  
  return combinedMarkdown;
}
