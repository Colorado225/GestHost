/**
 * Module base de données : pool pg + Drizzle + helper transactionnel.
 * Toutes les opérations critiques passent par withTransaction (README §93).
 */
import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { env } from '../common/env';

export const DB = 'GESTHOST_DB';
export type Db = NodePgDatabase<typeof schema> & { $pool: Pool };

@Injectable()
export class DatabaseService {
  readonly db: Db;
  private readonly logger = new Logger(DatabaseService.name);

  constructor() {
    const pool = new Pool({ connectionString: env().DATABASE_URL, max: 12 });
    pool.on('error', (e) => this.logger.error(`Pool error: ${e.message}`));
    this.db = drizzle(pool, { schema }) as Db;
    this.db.$pool = pool;
  }

  /** Transaction avec SELECT ... FOR UPDATE pour verrouiller les agrégats. */
  async withTransaction<T>(fn: (tx: NodePgDatabase<typeof schema>) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  async ping(): Promise<boolean> {
    try {
      await this.db.execute('select 1');
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy() {
    await this.db.$pool.end();
  }
}

@Global()
@Module({
  providers: [
    DatabaseService,
    { provide: DB, useExisting: DatabaseService },
  ],
  exports: [DB, DatabaseService],
})
export class DatabaseModule {}
