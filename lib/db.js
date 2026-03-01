// PostgreSQL connection pool for claude-memory scripts
// Reads DATABASE_URL from apps/web/.env.local

const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

let pool = null;

function getDatabaseUrl() {
  // Check environment first
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  // Read from .env.local
  const envPath = path.resolve(__dirname, '../../../apps/web/.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^DATABASE_URL\s*=\s*["']?(.+?)["']?\s*$/);
      if (match) return match[1];
    }
  }

  // Fallback
  return 'postgresql://engram:engram@localhost:5432/engram';
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: getDatabaseUrl(),
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      logError('Unexpected pool error', err);
    });
  }
  return pool;
}

async function query(text, params) {
  const client = await getPool().connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function end() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

function logError(msg, err) {
  const logPath = path.resolve(__dirname, '../error.log');
  const entry = `[${new Date().toISOString()}] ${msg}: ${err?.message || err}\n${err?.stack || ''}\n\n`;
  try {
    fs.appendFileSync(logPath, entry);
  } catch (_) {
    // If we can't even log, just stderr
    process.stderr.write(entry);
  }
}

module.exports = { getPool, query, withTransaction, end, logError, getDatabaseUrl };
