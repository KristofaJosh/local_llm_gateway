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
    const stmt = db.prepare(`
      INSERT INTO logs (
        requestId, timestamp, type, method, path, model, userAgent, 
        statusCode, durationMs, inputTokens, outputTokens, body, response, isStream
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      logEntry.body || null,
      logEntry.response || null,
      logEntry.isStream ? 1 : 0
    );
  } catch (err) {
    logger.error(err, 'Failed to insert log into DB');
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
          outputTokens as output_tokens, body, response, isStream
        FROM logs 
        ORDER BY timestamp DESC, id DESC
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
          outputTokens as output_tokens, body, response, isStream
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

    let msg = `\x1b[34m[REQUEST]\x1b[0m [${id}] ${method} ${path}`;
    if (body) {
      const indentedBody = typeof body === 'string' ? body.split('\n').map(l => '  ' + l).join('\n') : JSON.stringify(body, null, 2);
      msg += `\n\x1b[90mRequest Body:\x1b[0m\n${indentedBody}`;
    }
    logger.info(rest, msg);
  },
  response: (data) => {
    const { id, method, path, response, duration_ms, statusCode, ...rest } = data;
    addToHistory('response', data);

    const color = statusCode >= 400 ? '\x1b[31m' : '\x1b[32m';
    let msg = `${color}[RESPONSE]\x1b[0m [${id}] ${method} ${path} (${duration_ms}ms)`;
    if (response) {
      const indentedRes = typeof response === 'string' ? response.split('\n').map(l => '  ' + l).join('\n') : JSON.stringify(response, null, 2);
      msg += `\n\x1b[90mResponse Body:\x1b[0m\n${indentedRes}`;
    }
    logger.info({ ...rest, statusCode }, msg);
  },
  info: (msg) => {
    logger.info(msg);
  },
  error: (msg, err) => {
    logger.error(err, msg);
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
