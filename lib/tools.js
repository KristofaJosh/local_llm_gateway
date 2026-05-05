import db from './db.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import * as cheerio from 'cheerio';

const STORAGE_DIR = path.join(process.cwd(), 'storage');

// Ensure storage directory exists
async function ensureStorage() {
  try {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  } catch (err) {}
}

/**
 * Tool: Generate Image
 */
export async function generateImage(args, config, onChunk) {
  const prompt = args.prompt;
  const model = config?.IMAGE_MODEL || 'x/flux2-klein:9b';
  const host = config?.OLLAMA_HOST || '127.0.0.1';
  const port = config?.OLLAMA_PORT || '11434';
  
  const refId = `img_${Math.random().toString(36).substring(2, 8)}`;
  
  let fullMarkdown = `\n\n![🎨 Generating Image...][${refId}]\n\n`;
  if (onChunk) onChunk(fullMarkdown);

  const response = await fetch(`http://${host}:${port}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model,
      prompt: prompt,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Generator failed: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const chunkBase64 = data.response || data.image || (data.images && data.images[0]);

  if (!chunkBase64) throw new Error(`No image data returned from generator.`);

  try {
    db.prepare('INSERT INTO images (id, base64, timestamp) VALUES (?, ?, ?)').run(
      refId,
      chunkBase64,
      new Date().toISOString()
    );
  } catch (err) {
    console.error('[TOOLS] Failed to store image in DB:', err);
  }

  const baseUrl = config?.BASE_URL || `http://${host}:${config?.GATEWAY_PORT || 11435}`;
  const imageUrl = `${baseUrl}/images/${refId}`;
  
  const definitionHeader = `\n\n\n[${refId}]: ${imageUrl}`;
  const definitionFooter = `\n\n`;
  
  if (onChunk) {
    onChunk(definitionHeader);
    onChunk(definitionFooter);
  }

  return fullMarkdown + definitionHeader + definitionFooter;
}

/**
 * Tool: Web Search
 */
/**
 * Tool: Web Search
 */
export async function webSearch(args, config, onChunk) {
  const { query } = args;
  const host = config?.OLLAMA_HOST || '127.0.0.1';
  const port = config?.OLLAMA_PORT || '11434';
  
  if (onChunk) onChunk(`\n\n*(Searching the web for "${query}"...)*\n\n`);

  try {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    if (!response.ok) throw new Error(`Search failed with status ${response.status}`);
    
    const html = await response.text();
    const $ = cheerio.load(html);
    const searchResults = [];
    
    $('.result__body').slice(0, 5).each((i, el) => {
      const title = $(el).find('.result__title').text().trim();
      const snippet = $(el).find('.result__snippet').text().trim();
      const link = $(el).find('.result__url').text().trim();
      if (title && snippet) {
        searchResults.push(`Source: ${title}\nContent: ${snippet}\nURL: ${link}`);
      }
    });

    if (searchResults.length === 0) {
      const msg = `\n\n*(No search results found for "${query}")*\n\n`;
      if (onChunk) onChunk(msg);
      return msg;
    }

    if (onChunk) onChunk(`*(Synthesizing answer from ${searchResults.length} sources...)*\n\n`);

    // Use Ollama to synthesize the answer
    const synthesisPrompt = `
You are a helpful assistant. Based on the following search results for the query "${query}", provide a concise and accurate answer to the user's request. 
If the results don't contain the answer, say so. 
Always cite the source titles if possible.

Search Results:
${searchResults.join('\n\n')}

Answer:
`;

    const synthesisResponse = await fetch(`http://${host}:${port}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config?.MODEL || 'llama3', 
        prompt: synthesisPrompt,
        stream: true,
      }),
    });

    if (!synthesisResponse.ok) {
      throw new Error(`Synthesis failed: ${synthesisResponse.status}`);
    }

    const reader = synthesisResponse.body.getReader();
    const decoder = new TextDecoder();
    let fullAnswer = `\n\n### Web Search Answer for "${query}":\n\n`;
    if (onChunk) onChunk(fullAnswer);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.response) {
            fullAnswer += data.response;
            if (onChunk) onChunk(data.response);
          }
        } catch (e) {
          // Skip partial JSON lines
        }
      }
    }

    const footer = `\n\n---\n*Sources searched: ${searchResults.length}*\n\n`;
    if (onChunk) onChunk(footer);
    return fullAnswer + footer;

  } catch (err) {
    const errorMsg = `\n\n*(Web search or synthesis failed: ${err.message})*\n\n`;
    if (onChunk) onChunk(errorMsg);
    return errorMsg;
  }
}

/**
 * Tool: Fetch URL
 */
export async function fetchUrl(args, config, onChunk) {
  const { url } = args;
  if (onChunk) onChunk(`\n\n*(Fetching content from ${url}...)*\n\n`);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    if (!response.ok) throw new Error(`Fetch failed with status ${response.status}`);
    
    const html = await response.text();
    const $ = cheerio.load(html);
    
    // Remove scripts, styles, etc.
    $('script, style, nav, footer, header').remove();
    
    const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 5000);
    const result = `\n\n## Content from ${url}:\n\n${text}...\n\n`;
    
    if (onChunk) onChunk(result);
    return result;
  } catch (err) {
    return `\n\n*(Failed to fetch URL: ${err.message})*\n\n`;
  }
}

/**
 * Tool: Get Current Time
 */
export async function getCurrentTime(args, config, onChunk) {
  const now = new Date();
  const result = `\n\n🕒 **Current Time:** ${now.toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})\n\n`;
  if (onChunk) onChunk(result);
  return result;
}

/**
 * Tool: Read Memory
 */
export async function readMemory(args, config, onChunk) {
  const memoryPath = path.join(process.cwd(), 'storage', 'memory.md');
  try {
    const content = await fs.readFile(memoryPath, 'utf8');
    const result = `\n\n## Agent Memory Content:\n\n${content}\n\n`;
    return result;
  } catch (err) {
    return `\n\n*(Error reading memory: ${err.message})*\n\n`;
  }
}

/**
 * Tool: Update Memory
 */
export async function updateMemory(args, config, onChunk) {
  const { content, key, value } = args;
  const memoryPath = path.join(process.cwd(), 'storage', 'memory.md');
  
  try {
    let finalContent = content;
    
    // If the model sent key/value instead of full content, perform a partial update
    if (key && value && !content) {
      const existing = await fs.readFile(memoryPath, 'utf8');
      const lines = existing.split('\n');
      const sectionHeader = `## ${key}`;
      let sectionIndex = lines.findIndex(l => l.trim().startsWith(sectionHeader));
      
      if (sectionIndex !== -1) {
        // Find the next section or end of file
        let nextSectionIndex = lines.findIndex((l, i) => i > sectionIndex && l.trim().startsWith('## '));
        if (nextSectionIndex === -1) nextSectionIndex = lines.length;
        
        // Check if the value already exists in the section to avoid duplicates
        const sectionLines = lines.slice(sectionIndex + 1, nextSectionIndex);
        if (!sectionLines.some(l => l.includes(value))) {
            lines.splice(sectionIndex + 1, 0, `- ${value}`);
        }
        finalContent = lines.join('\n');
      } else {
        // Append new section if not found
        finalContent = existing + `\n\n## ${key}\n- ${value}\n`;
      }
    }

    if (!finalContent) throw new Error("No content or key/value provided for update.");

    await fs.writeFile(memoryPath, finalContent, 'utf8');
    const msg = `\n\n✅ **Memory Updated Successfully.**\n\n`;
    return msg;
  } catch (err) {
    throw new Error(`Failed to update memory: ${err.message}`);
  }
}

/**
 * Tool: System Info
 */
export async function systemInfo(args, config, onChunk) {
  const info = {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpus: os.cpus().length,
    totalMem: (os.totalmem() / 1024 / 1024 / 1024).toFixed(2) + ' GB',
    freeMem: (os.freemem() / 1024 / 1024 / 1024).toFixed(2) + ' GB',
    uptime: (os.uptime() / 3600).toFixed(2) + ' hours'
  };
  
  const result = `\n\n💻 **System Info:**\n- OS: ${info.platform} ${info.release}\n- Arch: ${info.arch}\n- CPUs: ${info.cpus}\n- Memory: ${info.freeMem} / ${info.totalMem} free\n- Uptime: ${info.uptime}\n\n`;
  if (onChunk) onChunk(result);
  return result;
}

// Map tool names to their implementation functions
export const availableFunctions = {
  generate_image: generateImage,
  web_search: webSearch,
  fetch_url: fetchUrl,
  get_current_time: getCurrentTime,
  system_info: systemInfo,
  read_memory: readMemory,
  update_memory: updateMemory
};

// Tool definitions for LLM injection
export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "generate_image",
      description: "Use this tool to generate an image whenever the user asks for a picture, drawing, or photograph.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "A highly detailed visual description of the image to generate based on the user's request."
          }
        },
        required: ["prompt"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for real-time information, news, or specific facts.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch the text content of a specific URL to read its content.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch." }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Get the current date, time, and timezone.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "system_info",
      description: "Get information about the system (OS, CPU, Memory).",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_memory",
      description: "Read the agent's long-term memory (memory.md) to recall user preferences, project status, and key facts.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_memory",
      description: "Update the agent's long-term memory (memory.md). Use this to store new information about the user, project progress, or important decisions. You can provide the full 'content' or a specific 'key' and 'value' to update a section.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The full updated content of the memory.md file." },
          key: { type: "string", description: "The section header (e.g., 'User', 'Knowledge')." },
          value: { type: "string", description: "The information to add to that section." }
        }
      }
    }
  }
];

/**
 * Executes a list of tool calls and aggregates results
 */
export async function executeToolCalls(toolCalls, config, onChunk) {
  let combinedMarkdown = '';
  for (const call of toolCalls) {
    const functionName = call.function.name;
    const functionToCall = availableFunctions[functionName];
    
    if (functionToCall) {
      let args = call.function.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch(e) {
            console.error(`[TOOLS] Failed to parse arguments for ${functionName}:`, args);
        }
      }
      
      try {
        console.log(`[TOOLS] Executing ${functionName}...`);
        const resultMarkdown = await functionToCall(args, config, onChunk);
        combinedMarkdown += resultMarkdown;
      } catch (err) {
        console.error(`[TOOLS] Error in ${functionName}:`, err);
        const errMsg = `\n\n*(Error calling ${functionName}: ${err.message})*\n\n`;
        if (onChunk) onChunk(errMsg);
        combinedMarkdown += errMsg;
      }
    }
  }
  return combinedMarkdown;
}
