import pino from 'pino';
import { EventEmitter } from 'events';
import db from './db.js';

const logger = pino({
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      ignore: 'pid,hostname,type',
      messageFormat: '{msg}',
      translateTime: 'SYS:standard',
    },
  },
});

const logEvents = new EventEmitter();
const MAX_HISTORY = 50;

function addToHistory(type, data) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    type,
    ...data
  };

  try {
    // Check if we already have a log for this requestId
    const existing = db.prepare('SELECT id FROM logs WHERE requestId = ?').get(logEntry.id);

    if (existing) {
      // Update existing entry
      const updates = [];
      const values = [];
      
      const fields = {
        type: logEntry.type,
        method: logEntry.method,
        path: logEntry.path,
        model: logEntry.model,
        userAgent: logEntry.userAgent,
        statusCode: logEntry.statusCode,
        durationMs: logEntry.duration_ms,
        inputTokens: logEntry.input_tokens,
        outputTokens: logEntry.output_tokens,
        requestSize: logEntry.request_size,
        responseSize: logEntry.response_size,
        body: logEntry.body,
        response: logEntry.response,
        isStream: logEntry.isStream !== undefined ? (logEntry.isStream ? 1 : 0) : undefined
      };

      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined && value !== null) {
          updates.push(`${key} = ?`);
          values.push(value);
        }
      }

      if (updates.length > 0) {
        values.push(logEntry.id);
        db.prepare(`UPDATE logs SET ${updates.join(', ')} WHERE requestId = ?`).run(...values);
      }
    } else {
      // Insert new entry
      const stmt = db.prepare(`
        INSERT INTO logs (
          requestId, timestamp, type, method, path, model, userAgent, 
          statusCode, durationMs, inputTokens, outputTokens, requestSize, responseSize, body, response, isStream
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        logEntry.id,
        logEntry.timestamp,
        logEntry.type,
        logEntry.method || null,
        logEntry.path || null,
        logEntry.model || null,
        logEntry.userAgent || null,
        logEntry.statusCode || null,
        logEntry.duration_ms || null,
        logEntry.input_tokens || null,
        logEntry.output_tokens || null,
        logEntry.request_size || null,
        logEntry.response_size || null,
        logEntry.body || null,
        logEntry.response || null,
        logEntry.isStream ? 1 : 0
      );
    }
  } catch (err) {
    logger.error(err, 'Failed to save log to DB');
  }

  logEvents.emit('log', logEntry);
}

/**
 * Custom logger that only outputs Request and Response information.
 */
const trafficLogger = {
  events: logEvents,
  getHistory: (limit = MAX_HISTORY) => {
    try {
      const rows = db.prepare(`
        SELECT 
          requestId as id, timestamp, type, method, path, model, userAgent, 
          statusCode, durationMs as duration_ms, inputTokens as input_tokens, 
          outputTokens as output_tokens, requestSize as request_size, 
          responseSize as response_size, body, response, isStream
        FROM logs 
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(limit);
      
      return rows.map(row => ({
        ...row,
        isStream: Boolean(row.isStream)
      })).reverse();
    } catch (err) {
      logger.error(err, 'Failed to fetch logs from DB');
      return [];
    }
  },
  getById: (requestId) => {
    try {
      const rows = db.prepare(`
        SELECT 
          requestId as id, timestamp, type, method, path, model, userAgent, 
          statusCode, durationMs as duration_ms, inputTokens as input_tokens, 
          outputTokens as output_tokens, requestSize as request_size, 
          responseSize as response_size, body, response, isStream
        FROM logs 
        WHERE requestId = ?
      `).all(requestId);
      
      return rows.map(row => ({
        ...row,
        isStream: Boolean(row.isStream)
      }));
    } catch (err) {
      logger.error(err, 'Failed to fetch log by ID from DB');
      return [];
    }
  },
  request: (data) => {
    const { id, method, path, body, ...rest } = data;
    addToHistory('request', data);

    /* CLI logging removed in favor of dashboard
    let msg = `\x1b[34m[REQUEST]\x1b[0m [${id}] ${method} ${path}`;
    if (body) {
      const indentedBody = typeof body === 'string' ? body.split('\n').map(l => '  ' + l).join('\n') : JSON.stringify(body, null, 2);
      msg += `\n\x1b[90mRequest Body:\x1b[0m\n${indentedBody}`;
    }
    logger.info(rest, msg);
    */
  },
  response: (data) => {
    const { id, method, path, response, duration_ms, statusCode, ...rest } = data;
    addToHistory('response', data);
  },
  streaming: (data) => {
    addToHistory('streaming', data);
  },
  info: (msg) => {
    // logger.info(msg);
  },
  error: (msg, err) => {
    // logger.error(err, msg);
  },
  clearLogs: () => {
    try {
      db.prepare('DELETE FROM logs').run();
      logger.info('Logs cleared successfully');
      return true;
    } catch (err) {
      logger.error(err, 'Failed to clear logs');
      return false;
    }
  }
};

export default trafficLogger;
