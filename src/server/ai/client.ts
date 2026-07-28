import { getSetting } from '../db/index.js';
import { providerForModel } from '../config.js';
import { anthropicProvider } from './providers/anthropic.js';
import { openaiProvider } from './providers/openai.js';
import type { LlmProvider, ProviderId, StructuredRequest } from './providers/types.js';

export { ProviderRefusalError as AiRefusalError } from './providers/types.js';
export type { StructuredRequest } from './providers/types.js';

const PROVIDERS: Record<ProviderId, LlmProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
};

export function modelId(): string {
  return getSetting('model');
}

/**
 * The active provider. Derived from the model id rather than trusting the
 * `provider` setting alone, so a mismatched pair (provider=openai, model=claude-*)
 * still routes to the vendor that can actually serve the model.
 */
export function activeProvider(): LlmProvider {
  return PROVIDERS[providerForModel(modelId())];
}

export function providerById(id: ProviderId): LlmProvider {
  return PROVIDERS[id];
}

export function allProviders(): LlmProvider[] {
  return [anthropicProvider, openaiProvider];
}

/**
 * Runs one agentic turn and returns validated structured output.
 *
 * Every job in the app goes through here. The provider supplies web search, URL
 * fetching, and a strict "submit" tool that carries the answer back; the calling
 * job only sees a validated object.
 */
export function runStructured<T>(req: StructuredRequest<T>): Promise<T> {
  return activeProvider().runStructured(req);
}
