import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../logs.db');
const db = new Database(dbPath);

// Initialize schema
// We store logs as separate entries (request/response) to match the existing logic,
// but we use a single table with all possible fields.
db.exec(`
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requestId TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    type TEXT NOT NULL,
    method TEXT,
    path TEXT,
    model TEXT,
    userAgent TEXT,
    statusCode INTEGER,
    durationMs INTEGER,
    inputTokens INTEGER,
    outputTokens INTEGER,
    requestSize INTEGER,
    responseSize INTEGER,
    body TEXT,
    response TEXT,
    isStream INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_requestId ON logs(requestId);
  CREATE INDEX IF NOT EXISTS idx_timestamp ON logs(timestamp);
  
  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    base64 TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_image_timestamp ON images(timestamp);
`);

export default db;
