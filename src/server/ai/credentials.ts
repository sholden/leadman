import { allProviders, providerById } from './client.js';
import { providerForModel, shadowedEnvVars } from '../config.js';
import { getSetting } from '../db/index.js';
import type { ProviderId } from './providers/types.js';

export type KeyState = 'unchecked' | 'ok' | 'missing' | 'invalid' | 'unreachable' | 'no_credit';

/**
 * Credential health, tracked per provider rather than per process.
 *
 * Two accounts can be on two different vendors at the same time, so "is the key
 * good?" has no single answer any more — one Anthropic-based account being fine
 * says nothing about an OpenAI-based one. Each account's dashboard reports the
 * state of the vendor its own model setting selects.
 */
const states: Record<ProviderId, { state: KeyState; detail: string }> = {
  anthropic: { state: 'unchecked', detail: '' },
  openai: { state: 'unchecked', detail: '' },
};

const vendorName = (id: ProviderId) => (id === 'openai' ? 'OpenAI' : 'Anthropic');
const envVarFor = (id: ProviderId) => (id === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY');

/** Which vendor an account's configured model routes to. */
export function providerForAccount(accountId: string): ProviderId {
  return providerForModel(getSetting('model', accountId));
}

export function credentialStatus(accountId?: string) {
  const provider = accountId ? providerForAccount(accountId) : 'anthropic';
  return { ...states[provider], shadowedEnvVars, provider };
}

/** Installation-wide view, for the unauthenticated health endpoint. */
export function credentialSummary() {
  return {
    shadowedEnvVars,
    providers: allProviders().map((p) => ({
      provider: p.id,
      configured: p.hasApiKey(),
      ...states[p.id],
    })),
  };
}

/**
 * Records a billing/auth failure seen during an actual run.
 *
 * The boot check is a free GET, so it proves the key authenticates but says
 * nothing about whether the account can pay. Both vendors let a valid key sit on
 * an empty balance, and the app would otherwise report "verified" while every job
 * failed. Ordinary rate limits are deliberately NOT treated as a credential
 * problem — those are transient.
 */
export function reportRuntimeFailure(err: unknown, provider: ProviderId = 'anthropic'): void {
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : String(err);
  const outOfCredit =
    /insufficient_quota|credit balance is too low|exceeded your current quota|billing/i.test(message);

  if (outOfCredit) {
    states[provider] = {
      state: 'no_credit',
      detail:
        provider === 'openai'
          ? 'Your OpenAI key is valid but the account has no remaining quota. Add credit or a payment method at platform.openai.com/settings/organization/billing.'
          : 'Your Anthropic key is valid but the account is out of credit. Top up at console.anthropic.com under Plans & Billing.',
    };
    return;
  }
  if (status === 401 || status === 403) {
    states[provider] = {
      state: 'invalid',
      detail: `The API key was rejected by ${vendorName(provider)} during a run.`,
    };
  }
}

/**
 * Validates the configured API keys at boot against each vendor's Models
 * endpoint — a plain GET, so it costs nothing and consumes no tokens.
 *
 * Every configured provider is checked, not just the one some account happens to
 * have selected, because an account can switch vendors at any time and a stale
 * "unchecked" would be reported as though nothing were wrong.
 */
export async function verifyCredentials(): Promise<void> {
  await Promise.all(allProviders().map((p) => verifyProvider(p.id)));
}

async function verifyProvider(id: ProviderId): Promise<void> {
  const provider = providerById(id);
  if (!provider.hasApiKey()) {
    states[id] = { state: 'missing', detail: `${envVarFor(id)} is not set.` };
    return;
  }
  try {
    // Lists models rather than retrieving one: this validates the key itself,
    // and at boot there is no account in scope whose model choice we could ask
    // about — nor should there be, since each account picks its own.
    await provider.availableModels();
    states[id] = { state: 'ok', detail: '' };
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const message = err instanceof Error ? err.message : String(err);
    if (status === 401 || status === 403) {
      states[id] = {
        state: 'invalid',
        detail: `The API key was rejected by ${vendorName(id)}. Check ${envVarFor(id)}.`,
      };
    } else if (status === 404) {
      // Key is fine; the model name isn't.
      states[id] = { state: 'ok', detail: '' };
    } else {
      states[id] = {
        state: 'unreachable',
        detail: `Could not reach the ${vendorName(id)} API: ${message}`,
      };
    }
  }
}

/** True when at least one vendor is usable, for the boot log. */
export function anyProviderUsable(): boolean {
  return allProviders().some((p) => states[p.id].state === 'ok');
}
