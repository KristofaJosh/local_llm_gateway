const pino = require('pino');

const logger = pino({
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      ignore: 'pid,hostname,type', // Remove noise from log line
      messageFormat: '{msg}', // Only show our custom message
      translateTime: 'SYS:standard',
    },
  },
});

/**
 * Custom logger that only outputs Request and Response information.
 */
const trafficLogger = {
  request: (data) => {
    const { id, method, path, body, ...rest } = data;
    // Log incoming API calls with blue [REQUEST] prefix
    let msg = `\x1b[34m[REQUEST]\x1b[0m [${id}] ${method} ${path}`;
    // Indent and append body if present
    if (body) {
      const indentedBody = typeof body === 'string' ? body.split('\n').map(l => '  ' + l).join('\n') : JSON.stringify(body, null, 2);
      msg += `\n\x1b[90mRequest Body:\x1b[0m\n${indentedBody}`;
    }
    logger.info(rest, msg);
  },
  response: (data) => {
    const { id, method, path, response, duration_ms, statusCode, ...rest } = data;
    // Log API responses with green/red [RESPONSE] prefix
    const color = statusCode >= 400 ? '\x1b[31m' : '\x1b[32m';
    let msg = `${color}[RESPONSE]\x1b[0m [${id}] ${method} ${path} (${duration_ms}ms)`;
    // Indent and append response if present
    if (response) {
      const indentedRes = typeof response === 'string' ? response.split('\n').map(l => '  ' + l).join('\n') : JSON.stringify(response, null, 2);
      msg += `\n\x1b[90mResponse Body:\x1b[0m\n${indentedRes}`;
    }
    logger.info({ ...rest, statusCode }, msg);
  },
  info: (msg) => {
    // Only used for critical startup info if needed, otherwise hidden
    // We can comment this out or set level to silent if the user wants strictly NO other logs.
    // For now, I'll keep it but we can tune it.
  },
  error: (msg, err) => {
    logger.error(err, msg);
  }
};

module.exports = trafficLogger;
