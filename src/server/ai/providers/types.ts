import type { z } from 'zod';
import type { BudgetGuard } from '../budget.js';

export type ProviderId = 'anthropic' | 'openai';

/** Effort levels the app speaks. Each provider maps these to its own scale. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Usage normalized across providers so one budget guard and one ledger work for
 * both. Cached-token accounting differs — Anthropic reports cache writes and reads
 * separately, OpenAI reports only cached input — so both fields are optional.
 */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Hosted search invocations, where the provider bills them per request. */
  webSearchRequests: number;
}

export interface StructuredRequest<T> {
  purpose: string;
  system: string;
  prompt: string;
  /** Name of the tool the model must call to hand back its answer. */
  toolName: string;
  toolDescription: string;
  /** JSON Schema. Must satisfy strict mode on both providers: every property
   *  required, additionalProperties false, no numeric/length constraints. */
  inputSchema: Record<string, unknown>;
  validator: z.ZodType<T>;
  budget: BudgetGuard;
  /** Give the model web search and URL fetching. */
  research?: boolean;
  maxTokens?: number;
  maxIterations?: number;
  effort?: Effort;
}

export interface LlmProvider {
  readonly id: ProviderId;
  /** Model ids this account can actually use, queried live. */
  availableModels(): Promise<string[]>;
  /** Cheap auth check that costs no tokens. Throws on invalid credentials. */
  verifyCredentials(model: string): Promise<void>;
  /** Runs one agentic turn and returns validated structured output. */
  runStructured<T>(req: StructuredRequest<T>): Promise<T>;
  hasApiKey(): boolean;
}

export class ProviderRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderRefusalError';
  }
}
