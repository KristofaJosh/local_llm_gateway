const { spawn } = require('child_process');
const http = require('http');
const trafficLogger = require('./logger');

class OllamaManager {
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 11434;
    this.process = null;
  }

  start() {
    // Spawn ollama as a child process
    this.process = spawn('ollama', ['serve'], {
      env: {
        ...process.env,
        OLLAMA_HOST: `0.0.0.0:${this.port}`, // Bind to all interfaces for remote access
        OLLAMA_ORIGINS: '*' // Allow all origins for CORS
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.process.on('exit', (code) => {
      if (code !== 0) {
        trafficLogger.error('Ollama process exited unexpectedly', { code });
        process.exit(code || 1);
      }
    });

    // We suppress stdout/stderr logs as per user request to hide "every other logs"
    this.process.stdout.on('data', () => {});
    this.process.stderr.on('data', () => {});

    // Ensure child process is killed when the parent exits
    process.on('exit', () => this.stop());
    process.on('SIGINT', () => process.exit());
    process.on('SIGTERM', () => process.exit());
  }

  stop() {
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
  }

  async waitForReady(retries = 30) {
    const url = `http://${this.host}:${this.port}/api/tags`;
    
    // Poll the tags endpoint until it returns 200 OK
    for (let i = 0; i < retries; i++) {
      try {
        await new Promise((resolve, reject) => {
          const req = http.get(url, (res) => {
            if (res.statusCode === 200) resolve();
            else reject();
          });
          req.on('error', reject);
          req.end();
        });
        return true;
      } catch (e) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    throw new Error('Ollama failed to become ready in time');
  }

  async warmup(model = 'llama3') {
    return new Promise((resolve) => {
      // Run a simple 'ping' to force the model to load into VRAM
      const warmup = spawn('ollama', ['run', model, 'ping'], { stdio: 'ignore' });
      warmup.on('exit', resolve);
    });
  }
}

module.exports = OllamaManager;
