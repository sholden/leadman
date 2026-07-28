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
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  /** Contact string sent to Nominatim, per its usage policy. */
  geocodeContact: process.env.LEADMAN_CONTACT ?? 'leadman-local-app',
  /** Set LEADMAN_SCHEDULER=off to boot the UI without any background AI work. */
  schedulerEnabled: (process.env.LEADMAN_SCHEDULER ?? 'on') !== 'off',
} as const;

/**
 * Per-1M-token prices in USD, per model. Used only to enforce the local budget
 * caps and to show spend in the UI — it is an estimate, not a bill. Update these
 * when list prices change; nothing else reads provider pricing.
 */
export const MODEL_PRICING: Record<
  string,
  { input: number; output: number; provider: 'anthropic' | 'openai'; searchPerRequest?: number }
> = {
  // ---- Anthropic. Hosted web search is ~$10 per 1,000 requests, billed separately.
  'claude-fable-5': { input: 10, output: 50, provider: 'anthropic', searchPerRequest: 10 / 1000 },
  'claude-opus-5': { input: 5, output: 25, provider: 'anthropic', searchPerRequest: 10 / 1000 },
  'claude-opus-4-8': { input: 5, output: 25, provider: 'anthropic', searchPerRequest: 10 / 1000 },
  'claude-opus-4-7': { input: 5, output: 25, provider: 'anthropic', searchPerRequest: 10 / 1000 },
  'claude-opus-4-6': { input: 5, output: 25, provider: 'anthropic', searchPerRequest: 10 / 1000 },
  'claude-sonnet-5': { input: 3, output: 15, provider: 'anthropic', searchPerRequest: 10 / 1000 },
  'claude-sonnet-4-6': { input: 3, output: 15, provider: 'anthropic', searchPerRequest: 10 / 1000 },
  'claude-haiku-4-5': { input: 1, output: 5, provider: 'anthropic', searchPerRequest: 10 / 1000 },
  // Dated ids the models endpoint returns for older releases; same models, same prices.
  'claude-opus-4-5-20251101': { input: 5, output: 25, provider: 'anthropic', searchPerRequest: 10 / 1000 },
  'claude-opus-4-1-20250805': { input: 15, output: 75, provider: 'anthropic', searchPerRequest: 10 / 1000 },
  'claude-sonnet-4-5-20250929': { input: 3, output: 15, provider: 'anthropic', searchPerRequest: 10 / 1000 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, provider: 'anthropic', searchPerRequest: 10 / 1000 },

  // ---- OpenAI. Hosted web search is billed into tokens on these models rather
  // than per call, so searchPerRequest is 0.
  // NOTE: the gpt-5.6 family has a long-context tier that costs roughly double
  // these rates. These are the short-context figures; spend will under-report if
  // a request runs long enough to fall into the long-context tier.
  'gpt-5.6-sol': { input: 5, output: 30, provider: 'openai', searchPerRequest: 0 },
  'gpt-5.6-terra': { input: 2.5, output: 15, provider: 'openai', searchPerRequest: 0 },
  'gpt-5.6-luna': { input: 1, output: 6, provider: 'openai', searchPerRequest: 0 },
  'gpt-5.5': { input: 5, output: 30, provider: 'openai', searchPerRequest: 0 },
  'gpt-5.4': { input: 2.5, output: 15, provider: 'openai', searchPerRequest: 0 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, provider: 'openai', searchPerRequest: 0 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25, provider: 'openai', searchPerRequest: 0 },
  'gpt-5.2': { input: 1.75, output: 14, provider: 'openai', searchPerRequest: 0 },
  'gpt-5.1': { input: 1.25, output: 10, provider: 'openai', searchPerRequest: 0 },
  'gpt-5': { input: 1.25, output: 10, provider: 'openai', searchPerRequest: 0 },
  'gpt-5-mini': { input: 0.25, output: 2, provider: 'openai', searchPerRequest: 0 },
  'gpt-5-nano': { input: 0.05, output: 0.4, provider: 'openai', searchPerRequest: 0 },
  // "pro" tiers are far more expensive; listed so the budget guard prices them correctly.
  'gpt-5.5-pro': { input: 30, output: 180, provider: 'openai', searchPerRequest: 0 },
  'gpt-5.4-pro': { input: 30, output: 180, provider: 'openai', searchPerRequest: 0 },
  'gpt-5.2-pro': { input: 21, output: 168, provider: 'openai', searchPerRequest: 0 },
  'gpt-5-pro': { input: 15, output: 120, provider: 'openai', searchPerRequest: 0 },
  o3: { input: 2, output: 8, provider: 'openai', searchPerRequest: 0 },
  'o3-mini': { input: 1.1, output: 4.4, provider: 'openai', searchPerRequest: 0 },
  'o4-mini': { input: 1.1, output: 4.4, provider: 'openai', searchPerRequest: 0 },
};

const warnedUnpriced = new Set<string>();

/**
 * Price for a model. An unpriced model is deliberately costed at the most
 * expensive rate we know of rather than a cheap guess, so the budget guard errs
 * toward stopping early instead of quietly overspending on a model whose real
 * price we don't have. It warns once so the gap is visible.
 */
export function priceFor(model: string) {
  const known = MODEL_PRICING[model];
  if (known) return known;

  if (!warnedUnpriced.has(model)) {
    warnedUnpriced.add(model);
    console.warn(
      `[pricing] No price on file for "${model}". Costing it at the highest known rate ` +
        `($10/$50 per MTok) so the budget cap stays conservative. Add it to MODEL_PRICING ` +
        `in src/server/config.ts for accurate spend tracking.`,
    );
  }
  return {
    input: 10,
    output: 50,
    provider: providerForModel(model),
    searchPerRequest: 10 / 1000,
  };
}

/** True when spend for this model is an assumed worst case rather than a real price. */
export function isPriced(model: string): boolean {
  return model in MODEL_PRICING;
}

/** Which provider owns a model id. Falls back to a prefix guess for unlisted models. */
export function providerForModel(model: string): 'anthropic' | 'openai' {
  const known = MODEL_PRICING[model];
  if (known) return known.provider;
  return /^(gpt|o[0-9]|chatgpt)/i.test(model) ? 'openai' : 'anthropic';
}

/** Defaults for the `settings` table, seeded on first boot. */
export const DEFAULT_SETTINGS = {
  /** Which vendor to use. The model setting must belong to it. */
  provider: 'anthropic',
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
