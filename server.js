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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
  OLLAMA_HOST: process.env.OLLAMA_HOST || '127.0.0.1',
  OLLAMA_PORT: parseInt(process.env.OLLAMA_PORT || '11434'),
  GATEWAY_PORT: parseInt(process.env.GATEWAY_PORT || '11435'),
  OLLAMA_KEEP_ALIVE: process.env.OLLAMA_KEEP_ALIVE || '5m',
  GATEWAY_NAME: process.env.GATEWAY_NAME || 'ollama gateway',
  BODY_LIMIT: 500 * 1024 * 1024, // 500MB limit for large prompts/images
  TIMEOUT: 300000 // 5-minute timeout for long generations
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
    logger: false // Hide Fastify's internal logs
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

    const proxyReq = http.request(options, (proxyRes) => {
      const isStream = proxyRes.headers['content-type']?.includes('text/event-stream');

      // Handle streaming responses (Server-Sent Events)
      if (isStream) {
        reply.raw.writeHead(proxyRes.statusCode, proxyRes.headers);
        
        let capturedResponse = '';
        proxyRes.on('data', (chunk) => {
          capturedResponse += chunk.toString();
        });

        proxyRes.pipe(reply.raw);
        
        // Log that the response has started (helpful for UI to show "Streaming" status)
        trafficLogger.response({
          id: request.requestId,
          method: request.method,
          path: request.url,
          statusCode: proxyRes.statusCode,
          userAgent: request.userAgent,
          isStream: true,
          type: 'streaming' // Custom type to indicate active stream
        });

        proxyRes.on('end', () => {
          // Log completion of the stream with the captured body
          trafficLogger.response({
            id: request.requestId,
            method: request.method,
            path: request.url,
            statusCode: proxyRes.statusCode,
            duration_ms: Date.now() - request.startTime,
            userAgent: request.userAgent,
            output_tokens: estimateTokens(capturedResponse),
            response_size: Buffer.byteLength(capturedResponse),
            response: capturedResponse,
            isStream: true,
            type: 'response' // Reset to response on completion
          });
        });
        return;
      }

      // Handle standard (non-streaming) responses
      let responseBody = '';
      proxyRes.on('data', (chunk) => { responseBody += chunk.toString(); });
      proxyRes.on('end', () => {
        const duration = Date.now() - request.startTime;
        // Log final response metadata and token count
        let formattedResponse = responseBody;
        try {
          // Attempt to pretty-print if it's JSON
          formattedResponse = JSON.stringify(JSON.parse(responseBody), null, 2);
        } catch (e) {
          // If it's not a single JSON, try to format as multiple JSON objects (for SSE/NDJSON)
          try {
            formattedResponse = responseBody.split('\n')
              .map(line => {
                const trimmed = line.trim();
                if (!trimmed) return line;
                // Handle SSE format "data: {...}"
                const sseMatch = trimmed.match(/^data:\s*(.*)$/);
                const jsonPart = sseMatch ? sseMatch[1] : trimmed;
                try {
                  const parsed = JSON.parse(jsonPart);
                  return (sseMatch ? 'data: ' : '') + JSON.stringify(parsed, null, 2);
                } catch (e2) {
                  return line;
                }
              }).join('\n');
          } catch (e3) {
            // Fallback to original
          }
        }

        trafficLogger.response({
          id: request.requestId,
          method: request.method,
          path: request.url,
          statusCode: proxyRes.statusCode,
          duration_ms: duration,
          userAgent: request.userAgent,
          output_tokens: estimateTokens(responseBody),
          response_size: Buffer.byteLength(responseBody),
          response: formattedResponse
        });
        reply.status(proxyRes.statusCode).headers(proxyRes.headers).send(responseBody);
      });
    });

    proxyReq.on('error', (err) => {
      trafficLogger.error('Proxy error', err);
      reply.status(502).send({ error: 'Bad Gateway', message: err.message });
    });

    request.raw.on('close', () => {
      if (!reply.raw.writableEnded) {
        proxyReq.destroy(new Error('Client closed connection'));
      }
    });

    proxyReq.setTimeout(CONFIG.TIMEOUT, () => {
      proxyReq.destroy(new Error('Upstream timeout'));
    });

    // Write request body if present
    if (proxyBodyString) {
      proxyReq.write(proxyBodyString);
    }
    proxyReq.end();
  });

  app.get('/dashboard', (request, reply) => {
    return reply.view('dashboard.hbs', { gatewayName: CONFIG.GATEWAY_NAME });
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
