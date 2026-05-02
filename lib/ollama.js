import { spawn } from 'child_process';
import http from 'http';
import trafficLogger from './logger.js';

class OllamaManager {
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 11434;
    this.keepAlive = options.keepAlive || '5m';
    this.process = null;
  }

  async start() {
    // Check if something is already listening on the port
    try {
      const isReady = await this.isReady();
      if (isReady) {
        trafficLogger.info('Ollama is already running, skipping start.');
        return;
      }
    } catch (e) {
      // Not running, proceed to start
    }

    // Spawn ollama as a child process
    this.process = spawn('ollama', ['serve'], {
      env: {
        ...process.env,
        OLLAMA_HOST: `0.0.0.0:${this.port}`,
        OLLAMA_ORIGINS: '*',
        OLLAMA_KEEP_ALIVE: this.keepAlive
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.process.on('exit', (code) => {
      // If code is null, it was probably killed by us
      if (code !== 0 && code !== null) {
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

  async isReady() {
    const url = `http://${this.host}:${this.port}/api/tags`;
    return new Promise((resolve) => {
      const req = http.get(url, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.end();
    });
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

  async warmup(model = 'gemma4:e4b') {
    return new Promise((resolve) => {
      // Run a simple 'ping' to force the model to load into VRAM
      const warmup = spawn('ollama', ['run', model, 'ping'], { stdio: 'ignore' });
      warmup.on('exit', resolve);
    });
  }
}

export default OllamaManager;
