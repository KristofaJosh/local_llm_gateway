import pino from 'pino';
import { EventEmitter } from 'events';

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
const logHistory = [];
const MAX_HISTORY = 50;

function addToHistory(type, data) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    type,
    ...data
  };
  logHistory.push(logEntry);
  if (logHistory.length > MAX_HISTORY) logHistory.shift();
  logEvents.emit('log', logEntry);
}

/**
 * Custom logger that only outputs Request and Response information.
 */
const trafficLogger = {
  events: logEvents,
  getHistory: () => logHistory,
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
  }
};

export default trafficLogger;
