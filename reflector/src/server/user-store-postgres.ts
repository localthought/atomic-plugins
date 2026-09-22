import type { Pool } from 'pg';
import type { StoredUser, UserStore } from './user-store.js';

/**
 * Postgres-backed {@link UserStore}: one row per user in a single `jsonb`
 * column. Used when `DATABASE_URL` is set — typically on a host with an
 * ephemeral filesystem (a Heroku dyno, DO App Platform) where the file store
 * would lose connections on every restart/redeploy. `pg` is imported lazily so
 * a file-storage deployment never has to load it.
 */
export class PostgresUserStore implements UserStore {
  private constructor(private readonly pool: Pool) {}

  static async create(connectionString: string): Promise<PostgresUserStore> {
    const { default: pg } = await import('pg');
    // Managed Postgres (Heroku, DO) terminates TLS with a cert Node won't chain
    // to by default; a local database needs no TLS at all.
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
    const pool = new pg.Pool({
      connectionString,
      ssl: local ? undefined : { rejectUnauthorized: false },
    });
    return new PostgresUserStore(pool);
  }

  async init(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS reflector_users (
         session_id TEXT PRIMARY KEY,
         record     JSONB NOT NULL
       )`,
    );
  }

  async load(): Promise<StoredUser[]> {
    const result = await this.pool.query<{ record: StoredUser }>(
      'SELECT record FROM reflector_users',
    );
    return result.rows.map((row) => row.record);
  }

  async save(user: StoredUser): Promise<void> {
    await this.pool.query(
      `INSERT INTO reflector_users (session_id, record)
       VALUES ($1, $2)
       ON CONFLICT (session_id) DO UPDATE SET record = EXCLUDED.record`,
      [user.sessionId, JSON.stringify(user)],
    );
  }

  async remove(sessionId: string): Promise<void> {
    await this.pool.query('DELETE FROM reflector_users WHERE session_id = $1', [
      sessionId,
    ]);
  }
}
