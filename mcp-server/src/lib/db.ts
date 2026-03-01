// PostgreSQL connection pool for Total Recall Memory MCP server
// Reads DATABASE_URL from environment or .env file

import { Pool, PoolClient, QueryResult } from 'pg';
import * as path from 'path';
import * as fs from 'fs';

let pool: Pool | null = null;

function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  // Try .env in project root
  const envPath = path.resolve(__dirname, '../../../.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^DATABASE_URL\s*=\s*["']?(.+?)["']?\s*$/);
      if (match) return match[1];
    }
  }

  return 'postgresql://localhost:5432/postgres';
}

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getDatabaseUrl(),
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      process.stderr.write(`[total-recall] Pool error: ${err.message}\n`);
    });
  }
  return pool;
}

export async function query(text: string, params?: unknown[]): Promise<QueryResult> {
  const client = await getPool().connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

export async function end(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
