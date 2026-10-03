/**
 * Configuration centralisée (README §98) — validation stricte au boot.
 */
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().default('postgres://gesthost:gesthost@127.0.0.1:5432/gesthost_dev'),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  JWT_SECRET: z.string().min(16).default('gesthost-dev-secret-change-me'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  FNE_BASE_URL: z.string().optional(),
  FNE_API_KEY: z.string().optional(),
  FNE_API_SECRET: z.string().optional(),
  /** MODE=FNE_SIMULATION : adaptateur simulé (sandbox) tant que les specs officielles
   *  et credentials ne sont pas disponibles (README §5, §13). */
  FNE_MODE: z.enum(['SIMULATION', 'SANDBOX', 'PRODUCTION']).default('SIMULATION'),
  EMAIL_PROVIDER: z.string().default('log'),
  APP_TIMEZONE: z.string().default('Africa/Abidjan'),
});

export type AppEnv = z.infer<typeof EnvSchema>;

let cached: AppEnv | undefined;

export function env(): AppEnv {
  if (!cached) cached = EnvSchema.parse(process.env);
  return cached;
}

/** Le mode production refuse les secrets par défaut non changés. */
export function assertProductionSafety(e: AppEnv = env()) {
  if (e.NODE_ENV === 'production') {
    if (e.JWT_SECRET === 'gesthost-dev-secret-change-me') {
      throw new Error('JWT_SECRET doit être personnalisé en production');
    }
    if (e.FNE_MODE === 'SIMULATION') {
      throw new Error('FNE_MODE=SIMULATION interdit en production');
    }
  }
}
