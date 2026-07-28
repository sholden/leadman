import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');

/**
 * dotenv does not override variables already present in the environment. That is
 * the right default for a server, but it's a trap locally: you edit .env, restart,
 * and a stale exported key silently keeps winning. Detect that and say so.
 */
const envPath = path.join(ROOT, '.env');
const shadowed: string[] = [];
if (fs.existsSync(envPath)) {
  const fromFile = dotenv.parse(fs.readFileSync(envPath));
  for (const [key, value] of Object.entries(fromFile)) {
    if (process.env[key] !== undefined && process.env[key] !== value) shadowed.push(key);
  }
}
dotenv.config();

/** Variables where .env disagrees with an already-exported shell value. */
export const shadowedEnvVars = shadowed;

export const config = {
  port: Number(process.env.PORT ?? 8787),
  dbPath: process.env.LEADMAN_DB ?? path.join(ROOT, 'data', 'leadman.db'),
  webDist: path.join(ROOT, 'dist', 'web'),
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
  /** Contact string sent to Nominatim, per its usage policy. */
  geocodeContact: process.env.LEADMAN_CONTACT ?? 'leadman-local-app',
  /** Set LEADMAN_SCHEDULER=off to boot the UI without any background AI work. */
  schedulerEnabled: (process.env.LEADMAN_SCHEDULER ?? 'on') !== 'off',
} as const;

/**
 * Per-1M-token prices in USD. Used only to enforce the local budget caps and
 * to show spend in the UI — it is an estimate, not a bill.
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/** Anthropic charges roughly $10 per 1,000 web searches. */
export const WEB_SEARCH_COST_PER_REQUEST = 10 / 1000;

export function priceFor(model: string) {
  return MODEL_PRICING[model] ?? MODEL_PRICING['claude-opus-5'];
}

/** Defaults for the `settings` table, seeded on first boot. */
export const DEFAULT_SETTINGS = {
  model: 'claude-opus-5',
  effort: 'high',
  /** Hard ceiling on estimated spend per calendar month. Runs refuse to start above it. */
  monthlyBudgetUsd: '40',
  /** Hard ceiling on estimated spend for a single scheduler tick or manual run. */
  perRunBudgetUsd: '4',
  /** Minutes between scheduler ticks. */
  tickIntervalMinutes: '30',
  /** Hours between coverage assessments per profile. */
  assessIntervalHours: '72',
  /** Max sources scanned in one tick. */
  maxSourcesPerTick: '4',
  /** Max tracked projects researched in one tick. */
  maxResearchPerTick: '2',
  /** Sources to keep active per profile before discovery stops adding more. */
  targetActiveSources: '18',
  /** Minimum relevance (0-100) a candidate needs to be saved as a project. */
  minRelevance: '40',

  /**
   * Caps on the server-side research tools. These are the strongest cost dial in
   * the app: ~90% of spend is input tokens, and each internal tool step re-reads
   * the accumulated context, so cost grows faster than linearly with use count.
   */
  webSearchMaxUses: '8',
  webFetchMaxUses: '6',
  webFetchMaxContentTokens: '25000',
} as const;

export type SettingKey = keyof typeof DEFAULT_SETTINGS;
