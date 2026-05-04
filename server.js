import 'dotenv/config';
import fastify from 'fastify';
import view from '@fastify/view';
import handlebars from 'handlebars';
import path from 'path';
import { fileURLToPath } from 'url';
import tokenizer from 'gpt-tokenizer';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import trafficLogger from './lib/logger.js';
import OllamaManager from './lib/ollama.js';
import { executeToolCalls } from './lib/tools.js';
import db from './lib/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
  OLLAMA_HOST: process.env.OLLAMA_HOST || '127.0.0.1',
  OLLAMA_PORT: parseInt(process.env.OLLAMA_PORT || '11434'),
  GATEWAY_PORT: parseInt(process.env.GATEWAY_PORT || '11435'),
  OLLAMA_KEEP_ALIVE: process.env.OLLAMA_KEEP_ALIVE || '5m',
  GATEWAY_NAME: process.env.GATEWAY_NAME || 'ollama gateway',
  BODY_LIMIT: 500 * 1024 * 1024, // 500MB limit for large prompts/images
  TIMEOUT: 300000, // 5-minute timeout for long generations
  IMAGE_MODEL: process.env.IMAGE_MODEL || 'x/flux2-klein:9b'
};

/**
 * Estimates token count for given text or object.
 */
function estimateTokens(text) {
  try {
    if (!text) return 0;
    const content = typeof text === 'string' ? text : JSON.stringify(text);
    return tokenizer.encode(content).length;
  } catch (e) {
    return 0;
  }
}

async function startServer() {
  const ollama = new OllamaManager({
    host: CONFIG.OLLAMA_HOST,
    port: CONFIG.OLLAMA_PORT,
    keepAlive: CONFIG.OLLAMA_KEEP_ALIVE
  });

  // Start Ollama child process
  await ollama.start();

  const app = fastify({
    bodyLimit: CONFIG.BODY_LIMIT,
    trustProxy: true,
    logger: false, // Hide Fastify's internal logs
    connectionTimeout: 0, // Disable connection timeout for long generations
    keepAliveTimeout: 300000 // 5 minutes keep-alive
  });

  // Register view engine
  app.register(view, {
    engine: {
      handlebars: handlebars,
    },
    root: path.join(__dirname, 'views'),
  });

  // Register helpers
  handlebars.registerHelper('json', (context) => JSON.stringify(context));
  handlebars.registerHelper('gt', (a, b) => a > b);
  handlebars.registerHelper('or', (a, b) => a || b);
  handlebars.registerHelper('number', (num) => num ? num.toLocaleString() : 0);
  handlebars.registerHelper('bytes', (bytes) => {
    if (bytes === 0) return '0 B';
    if (!bytes) return 'N/A';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  });

  // Support any content type by parsing as JSON or raw
  app.addContentTypeParser('*', (request, payload, done) => {
    const chunks = [];
    payload.on('data', chunk => { chunks.push(chunk); });
    payload.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      try {
        done(null, body ? JSON.parse(body) : {});
      } catch (e) {
        done(null, body);
      }
    });
  });

  // Middleware to track request ID and start time
  app.addHook('onRequest', (request, reply, done) => {
    request.requestId = uuidv4().slice(0, 8);
    request.startTime = Date.now();
    request.userAgent = request.headers['user-agent'] || 'Unknown';
    done();
  });

  // Health check
  app.get('/health', async () => ({ status: 'ok' }));

  // Proxy logic
  app.all('*', (request, reply) => {
    // Inject the generate_image tool into chat requests if IMAGE_MODEL is configured
    const isChatRequest = request.url.includes('/api/chat') || request.url.includes('/v1/chat/completions');
    if (isChatRequest && request.body && typeof request.body === 'object') {
      if (CONFIG.IMAGE_MODEL) {
        if (!request.body.tools) {
          request.body.tools = [];
        }
        
        const hasImageTool = request.body.tools.some(t => t.function?.name === 'generate_image');
        if (!hasImageTool) {
          request.body.tools.push({
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
          });
        }
      }
    }

    const model = request.body?.model || 'unknown';
    const inputText = request.body?.prompt || request.body?.messages || request.body;
    
    let formattedBody = request.body;
    try {
      if (request.body && typeof request.body === 'object') {
        formattedBody = JSON.stringify(request.body, null, 2);
      }
    } catch (e) {
      // Keep as is
    }

    let proxyBodyString = '';
    if (request.body && (typeof request.body === 'object' ? Object.keys(request.body).length > 0 : request.body.length > 0)) {
      proxyBodyString = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    }
    const requestSize = proxyBodyString ? Buffer.byteLength(proxyBodyString) : 0;

    // Log the incoming request details
    trafficLogger.request({
      id: request.requestId,
      method: request.method,
      path: request.url,
      model,
      userAgent: request.userAgent,
      input_tokens: estimateTokens(inputText),
      request_size: requestSize,
      body: formattedBody
    });

    const proxyHeaders = {
      ...request.headers,
      host: `${CONFIG.OLLAMA_HOST}:${CONFIG.OLLAMA_PORT}`
    };

    // Remove headers that might interfere with proxying or logging
    delete proxyHeaders['accept-encoding']; // Force plain text for logging
    delete proxyHeaders['connection'];
    delete proxyHeaders['keep-alive'];

    if (proxyBodyString) {
      proxyHeaders['content-length'] = requestSize.toString();
    } else {
      delete proxyHeaders['content-length'];
    }

    // Prepare proxy request options
    const options = {
      hostname: CONFIG.OLLAMA_HOST,
      port: CONFIG.OLLAMA_PORT,
      path: request.url,
      method: request.method,
      headers: proxyHeaders
    };

    let isFinalized = false;
    let isStreaming = false;

    const finalizeLog = (statusCode, responseBody = '', isStream = false) => {
      if (isFinalized) return;
      isFinalized = true;
      trafficLogger.response({
        id: request.requestId,
        method: request.method,
        path: request.url,
        statusCode,
        duration_ms: Date.now() - request.startTime,
        userAgent: request.userAgent,
        output_tokens: estimateTokens(responseBody),
        response_size: Buffer.byteLength(responseBody),
        response: responseBody,
        isStream,
        type: 'response'
      });
    };

    const proxyReq = http.request(options, (proxyRes) => {
      const contentType = proxyRes.headers['content-type'] || '';
      isStreaming = contentType.includes('text/event-stream') || contentType.includes('application/x-ndjson') || contentType.includes('application/jsonl');

      // Handle streaming responses (Server-Sent Events and NDJSON)
      if (isStreaming) {
        let capturedResponse = '';
        let isToolCallStream = false;
        let toolCallBuffer = '';
        let headerWritten = false;
        let streamingLogged = false;

        proxyRes.on('data', (chunk) => {
          if (request.raw.aborted) return;
          
          const chunkStr = chunk.toString();
          capturedResponse += chunkStr;

          if (!streamingLogged) {
            trafficLogger.streaming({
              id: request.requestId,
              method: request.method,
              path: request.url,
              model,
              userAgent: request.userAgent,
              isStream: true
            });
            streamingLogged = true;
          }
          
          // Detect if this stream chunk contains a tool call
          if (chunkStr.includes('"tool_calls"') || isToolCallStream) {
            isToolCallStream = true;
            toolCallBuffer += chunkStr;
            // Do NOT write these chunks to the client yet
          } else {
            if (!headerWritten) {
              reply.raw.writeHead(proxyRes.statusCode, proxyRes.headers);
              headerWritten = true;
            }
            reply.raw.write(chunk);
          }
        });

        proxyRes.on('end', async () => {
          if (isToolCallStream) {
            // Reconstruct the JSON from the stream chunks to extract the tool calls
            const lines = toolCallBuffer.split('\n');
            let fullMessage = { tool_calls: [], content: '' };
            
            for (const line of lines) {
              const trimmedLine = line.trim();
              if (!trimmedLine) continue;
              
              let jsonStr = trimmedLine;
              if (trimmedLine.startsWith('data: ')) {
                jsonStr = trimmedLine.slice(6);
                if (jsonStr === '[DONE]') continue;
              }
              
              try {
                // Handle various formats of streamed JSON (OpenAI vs Ollama)
                const data = JSON.parse(jsonStr);
                const messageObj = data.message || (data.choices && data.choices[0]?.delta) || (data.choices && data.choices[0]?.message);
                
                if (messageObj?.tool_calls) {
                  messageObj.tool_calls.forEach(tc => {
                    // Find or create tool call entry
                    let existingTc = null;
                    if (tc.index !== undefined) {
                      existingTc = fullMessage.tool_calls[tc.index];
                      if (!existingTc) {
                        existingTc = { function: { name: '', arguments: '' } };
                        fullMessage.tool_calls[tc.index] = existingTc;
                      }
                    } else {
                      existingTc = fullMessage.tool_calls.find(t => t.function.name === tc.function?.name);
                    }

                    if (tc.function) {
                      if (tc.function.name) existingTc ? existingTc.function.name = tc.function.name : null;
                      if (tc.function.arguments) {
                        if (existingTc) {
                          existingTc.function.arguments += tc.function.arguments;
                        } else {
                          fullMessage.tool_calls.push({
                            function: {
                              name: tc.function.name,
                              arguments: tc.function.arguments
                            }
                          });
                        }
                      }
                    }
                  });
                }
                if (messageObj?.content) {
                  fullMessage.content += messageObj.content;
                }
              } catch (e) {
                // If it's not JSON, it might be a raw part of the stream, skip but don't break
              }
            }
            
            // Clean up empty tool call slots if any
            fullMessage.tool_calls = fullMessage.tool_calls.filter(tc => tc && tc.function.name);

            if (fullMessage.tool_calls.length > 0 && !request.raw.aborted) {
              try {
                if (!headerWritten) {
                  reply.raw.writeHead(200, { 'Content-Type': contentType });
                  headerWritten = true;
                }
                
                const isSSE = contentType.includes('text/event-stream');
                
                if (fullMessage.content) {
                  const contentChunkObj = isSSE 
                    ? { choices: [{ delta: { role: 'assistant', content: fullMessage.content } }] }
                    : { message: { role: 'assistant', content: fullMessage.content } };
                  const contentChunk = JSON.stringify(contentChunkObj);
                  const chunkStr = isSSE ? `data: ${contentChunk}\n\n` : `${contentChunk}\n`;
                  reply.raw.write(chunkStr);
                  capturedResponse += chunkStr;
                }
                
                // Pass dynamic configuration to tools
                const toolConfig = {
                  ...CONFIG,
                  BASE_URL: process.env.BASE_URL || `${request.protocol}://${request.headers.host}`
                };
                
                // Use a heartbeat to keep the connection alive while the tool is executing
                const heartbeat = setInterval(() => {
                  if (!request.raw.aborted) {
                    reply.raw.write(isSSE ? ':\n\n' : '\n');
                  }
                }, 10000);
                
                try {
                  await executeToolCalls(fullMessage.tool_calls, toolConfig, (chunk) => {
                    if (request.raw.aborted) return;
                    const streamChunkObj = isSSE 
                      ? { choices: [{ delta: { content: chunk } }] }
                      : { message: { content: chunk } };
                    const streamChunk = JSON.stringify(streamChunkObj);
                    const chunkStr = isSSE ? `data: ${streamChunk}\n\n` : `${streamChunk}\n`;
                    reply.raw.write(chunkStr);
                    capturedResponse += chunkStr;
                  });
                } finally {
                  clearInterval(heartbeat);
                }
                
                if (!request.raw.aborted) {
                  const responseObj = { model: request.body?.model, done: true };
                  if (isSSE) responseObj.choices = [{ delta: {}, finish_reason: 'stop' }];
                  
                  const finalChunk = JSON.stringify(responseObj);
                  const finalChunkStr = isSSE ? `data: ${finalChunk}\n\n` : `${finalChunk}\n`;
                  reply.raw.write(finalChunkStr);
                  capturedResponse += finalChunkStr;
                }
              } catch (err) {
                console.error("Tool execution error:", err);
              }
            }
          }
          
          finalizeLog(proxyRes.statusCode, capturedResponse, true);
          
          if (!headerWritten && !request.raw.aborted) {
            reply.raw.writeHead(proxyRes.statusCode, proxyRes.headers);
          }
          reply.raw.end();
        });
        return;
      }

      // Handle standard (non-streaming) responses
      let responseBody = '';
      proxyRes.on('data', (chunk) => { responseBody += chunk.toString(); });
      proxyRes.on('end', async () => {
        let finalResponseString = responseBody;
        
        try {
          const parsedRes = JSON.parse(responseBody);
          if (parsedRes.message?.tool_calls && !request.raw.aborted) {
            const toolConfig = {
              ...CONFIG,
              BASE_URL: process.env.BASE_URL || `${request.protocol}://${request.headers.host}`
            };
            const markdownImage = await executeToolCalls(parsedRes.message.tool_calls, toolConfig);
            parsedRes.message.content = (parsedRes.message.content || '') + markdownImage;
            delete parsedRes.message.tool_calls;
            finalResponseString = JSON.stringify(parsedRes);
          }
        } catch (e) {}

        let formattedResponse = finalResponseString;
        try {
          formattedResponse = JSON.stringify(JSON.parse(finalResponseString), null, 2);
        } catch (e) {
          try {
            formattedResponse = responseBody.split('\n')
              .map(line => {
                const trimmed = line.trim();
                if (!trimmed) return line;
                const sseMatch = trimmed.match(/^data:\s*(.*)$/);
                const jsonPart = sseMatch ? sseMatch[1] : trimmed;
                try {
                  const parsed = JSON.parse(jsonPart);
                  return (sseMatch ? 'data: ' : '') + JSON.stringify(parsed, null, 2);
                } catch (e2) { return line; }
              }).join('\n');
          } catch (e3) {}
        }

        finalizeLog(proxyRes.statusCode, formattedResponse, false);
        if (!reply.sent) {
          const resHeaders = { ...proxyRes.headers };
          delete resHeaders['content-length'];
          reply.status(proxyRes.statusCode).headers(resHeaders).send(finalResponseString);
        }
      });
    });

    proxyReq.on('error', (err) => {
      trafficLogger.error('Proxy error', err);
      const isClientClosed = err.message === 'Client closed connection' || err.code === 'ECONNRESET';
      const statusCode = isClientClosed ? 499 : 502;
      finalizeLog(statusCode, JSON.stringify({ error: err.message }), isStreaming);

      if (!reply.sent) {
        reply.status(statusCode).send({ error: isClientClosed ? 'Client Closed Request' : 'Bad Gateway', message: err.message });
      }
    });

    const onAbort = () => {
      if (!isFinalized) {
        proxyReq.destroy(new Error('Client closed connection'));
      }
    };

    reply.raw.on('close', onAbort);

    proxyReq.setTimeout(CONFIG.TIMEOUT, () => {
      proxyReq.destroy(new Error('Upstream timeout'));
    });

    if (proxyBodyString) {
      proxyReq.write(proxyBodyString);
    }
    proxyReq.end();
  });

  app.get('/dashboard', (request, reply) => {
    return reply.view('dashboard.hbs', { gatewayName: CONFIG.GATEWAY_NAME });
  });

  app.get('/images/:id', async (request, reply) => {
    const { id } = request.params;
    try {
      const row = db.prepare('SELECT base64 FROM images WHERE id = ?').get(id);
      if (!row) {
        return reply.status(404).send({ error: 'Image not found' });
      }
      const buffer = Buffer.from(row.base64, 'base64');
      reply.type('image/jpeg').send(buffer);
    } catch (err) {
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  app.post('/logs/clear', async (request, reply) => {
    const success = trafficLogger.clearLogs();
    if (success) {
      return reply.send({ success: true });
    } else {
      return reply.status(500).send({ error: 'Failed to clear logs' });
    }
  });

  app.get('/dashboard/:id', (request, reply) => {
    const { id } = request.params;
    const entries = trafficLogger.getById(id);
    
    if (entries.length === 0) {
      return reply.status(404).send({ error: 'Log not found' });
    }

    // Merge them for a unified view, skipping nulls to preserve data across entries (e.g. request body)
    const log = entries.reduce((acc, curr) => {
      for (const [key, value] of Object.entries(curr)) {
        if (value !== null && value !== undefined) {
          acc[key] = value;
        }
      }
      return acc;
    }, {});
    
    return reply.view('log_detail.hbs', { log, gatewayName: CONFIG.GATEWAY_NAME });
  });

  app.get('/logs/stream', (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    // Send history first
    const history = trafficLogger.getHistory();
    reply.raw.write(`data: ${JSON.stringify(history)}\n\n`);

    const onLog = (log) => {
      reply.raw.write(`data: ${JSON.stringify(log)}\n\n`);
    };

    trafficLogger.events.on('log', onLog);

    request.raw.on('close', () => {
      trafficLogger.events.off('log', onLog);
    });
  });

  try {
    await ollama.waitForReady();
    // Optional warmup can be done in background
    ollama.warmup().catch(() => {});

    await app.listen({ port: CONFIG.GATEWAY_PORT, host: '0.0.0.0' });
    // console.log(`\x1b[32m[SERVER]\x1b[0m Sharing Ollama on port ${CONFIG.GATEWAY_PORT}`);
  } catch (err) {
    trafficLogger.error('Failed to start server', err);
    process.exit(1);
  }
}

startServer();
