import { Pool, QueryResult, PoolClient } from 'pg';

/** Get or create the PostgreSQL connection pool (singleton) */
export function getPool(): Pool;

/** Execute a parameterized query */
export function query(text: string, params?: unknown[]): Promise<QueryResult>;

/** Execute a function within a database transaction (auto COMMIT/ROLLBACK) */
export function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;

/** Close the connection pool */
export function end(): Promise<void>;

/** Log an error to error.log or stderr */
export function logError(msg: string, err?: Error | unknown): void;

/** Get the resolved DATABASE_URL */
export function getDatabaseUrl(): string;
