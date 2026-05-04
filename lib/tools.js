export async function generateImage(prompt, config, onChunk) {
  const model = config?.IMAGE_MODEL || 'x/flux2-klein:9b';
  const host = config?.OLLAMA_HOST || '127.0.0.1';
  const port = config?.OLLAMA_PORT || '11434';
  
  // Generate a unique reference ID to avoid collisions if multiple images are generated
  const refId = `img_${Math.random().toString(36).substring(2, 8)}`;
  
  let fullMarkdown = `\n\n![🎨 Generating Image...][${refId}]\n\n`;
  if (onChunk) onChunk(fullMarkdown);

  const response = await fetch(`http://${host}:${port}/api/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model,
      prompt: prompt,
      stream: false, // Ollama does not support streaming base64 image generation
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Generator failed: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const chunkBase64 = data.response || data.image || (data.images && data.images[0]);

  if (!chunkBase64) {
    console.error('[TOOLS] Empty response from Ollama:', data);
    throw new Error(`No image data returned from generator.`);
  }

  // Use robust newlines and chunk the base64 data for streaming to avoid large message issues
  const definitionHeader = `\n\n\n[${refId}]: data:image/jpeg;base64,`;
  const definitionFooter = `\n\n`;
  
  if (onChunk) {
    onChunk(definitionHeader);
    // Chunk the base64 data in 16KB blocks
    const chunkSize = 16384;
    for (let i = 0; i < chunkBase64.length; i += chunkSize) {
      onChunk(chunkBase64.slice(i, i + chunkSize));
    }
    onChunk(definitionFooter);
  }

  return fullMarkdown + definitionHeader + chunkBase64 + definitionFooter;
}

// 1. Create a lookup object
export const availableFunctions = {
  generate_image: generateImage
};

// 2. Helper to execute the tool calls
export async function executeToolCalls(toolCalls, config, onChunk) {
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
        const resultMarkdown = await functionToCall(args.prompt, config, onChunk);
        combinedMarkdown += resultMarkdown;
        console.log(`[TOOLS] Image generated successfully!`);
      } catch (err) {
        console.error(`[TOOLS] Error generating image:`, err);
        const errMsg = `\n\n*(Error generating image: ${err.message})*\n\n`;
        if (onChunk) onChunk(errMsg);
        combinedMarkdown += errMsg;
      }
    }
  }
  return combinedMarkdown;
}
