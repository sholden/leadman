import { describe, expect, it } from 'vitest';
import { MODEL_PRICING, priceFor, providerForModel, isPriced } from '../src/server/config.js';
import { estimateCost } from '../src/server/ai/budget.js';
import type { NormalizedUsage } from '../src/server/ai/providers/types.js';

const usage = (over: Partial<NormalizedUsage> = {}): NormalizedUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  webSearchRequests: 0,
  ...over,
});

describe('provider routing', () => {
  it('routes known models to their vendor', () => {
    expect(providerForModel('claude-opus-5')).toBe('anthropic');
    expect(providerForModel('gpt-5.6-luna')).toBe('openai');
    expect(providerForModel('o4-mini')).toBe('openai');
  });

  it('guesses by prefix for models not in the price table', () => {
    // Vendors ship models faster than this table gets updated; an unknown gpt-*
    // must still reach OpenAI rather than being sent to Anthropic.
    expect(providerForModel('gpt-9-unreleased')).toBe('openai');
    expect(providerForModel('claude-opus-99')).toBe('anthropic');
  });

  it('agrees with the provider recorded in the price table', () => {
    for (const [model, entry] of Object.entries(MODEL_PRICING)) {
      expect(providerForModel(model), model).toBe(entry.provider);
    }
  });
});

describe('cost estimation', () => {
  it('prices Anthropic tokens and per-request web search', () => {
    // 1M in @ $5 + 1M out @ $25 + 100 searches @ $0.01
    const cost = estimateCost('claude-opus-5', {
      ...usage({ inputTokens: 1_000_000, outputTokens: 1_000_000, webSearchRequests: 100 }),
    });
    expect(cost).toBeCloseTo(31, 5);
  });

  it('prices OpenAI tokens with search folded into tokens', () => {
    const cost = estimateCost('gpt-5.1', usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }));
    expect(cost).toBeCloseTo(11.25, 5);
  });

  it('charges cached input at one tenth', () => {
    const cost = estimateCost('gpt-5.1', usage({ cacheReadTokens: 1_000_000 }));
    expect(cost).toBeCloseTo(0.125, 5);
  });

  it('charges cache writes at 1.25x', () => {
    const cost = estimateCost('claude-opus-5', usage({ cacheWriteTokens: 1_000_000 }));
    expect(cost).toBeCloseTo(6.25, 5);
  });

  it('costs nothing for empty usage', () => {
    expect(estimateCost('claude-opus-5', usage())).toBe(0);
  });

  it('never returns NaN even for a model nobody has priced', () => {
    const cost = estimateCost('some-model-from-the-future', usage({ inputTokens: 1000 }));
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost).toBeGreaterThan(0);
  });
});

describe('unpriced models fail safe', () => {
  it('costs an unknown model at the highest known rate, not a cheap guess', () => {
    // The budget guard must stop early rather than overspend on a model whose
    // real price we do not have. A previous bug priced everything unknown at
    // Opus rates, which would have under-billed gpt-5.5-pro by 6x.
    const unknown = priceFor('totally-made-up-model');
    const dearest = Math.max(...Object.values(MODEL_PRICING).map((p) => p.output));
    expect(unknown.output).toBeGreaterThanOrEqual(dearest);
    expect(isPriced('totally-made-up-model')).toBe(false);
  });

  it('reports known models as priced', () => {
    expect(isPriced('claude-opus-5')).toBe(true);
    expect(isPriced('gpt-5.6-luna')).toBe(true);
  });

  it('has sane numbers for every listed model', () => {
    for (const [model, p] of Object.entries(MODEL_PRICING)) {
      expect(p.input, `${model} input`).toBeGreaterThan(0);
      expect(p.output, `${model} output`).toBeGreaterThan(0);
      // Output is dearer than input on every model either vendor sells.
      expect(p.output, `${model}`).toBeGreaterThanOrEqual(p.input);
    }
  });
});
