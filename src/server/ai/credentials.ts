import { activeProvider, modelId } from './client.js';
import { config, shadowedEnvVars } from '../config.js';

export type KeyState = 'unchecked' | 'ok' | 'missing' | 'invalid' | 'unreachable' | 'no_credit';

let state: KeyState = 'unchecked';
let detail = '';

export function credentialStatus() {
  return { state, detail, shadowedEnvVars, provider: providerId };
}

let providerId = 'anthropic';

/**
 * Records a billing/auth failure seen during an actual run.
 *
 * The boot check is a free GET, so it proves the key authenticates but says
 * nothing about whether the account can pay. Both vendors let a valid key sit on
 * an empty balance, and the app would otherwise report "verified" while every job
 * failed. Ordinary rate limits are deliberately NOT treated as a credential
 * problem — those are transient.
 */
export function reportRuntimeFailure(err: unknown): void {
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : String(err);
  const outOfCredit =
    /insufficient_quota|credit balance is too low|exceeded your current quota|billing/i.test(message);

  if (outOfCredit) {
    state = 'no_credit';
    detail =
      providerId === 'openai'
        ? 'Your OpenAI key is valid but the account has no remaining quota. Add credit or a payment method at platform.openai.com/settings/organization/billing.'
        : 'Your Anthropic key is valid but the account is out of credit. Top up at console.anthropic.com under Plans & Billing.';
    return;
  }
  if (status === 401 || status === 403) {
    state = 'invalid';
    detail = `The API key was rejected by ${providerId === 'openai' ? 'OpenAI' : 'Anthropic'} during a run.`;
  }
}

/**
 * Validates the API key at boot against the Models endpoint — a plain GET, so it
 * costs nothing and consumes no tokens. Without this the app cheerfully reports
 * "key configured" for a key the API rejects, and the first failure only shows up
 * inside a run.
 */
export async function verifyCredentials(): Promise<void> {
  const provider = activeProvider();
  providerId = provider.id;
  const envVar = provider.id === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  if (!provider.hasApiKey()) {
    state = 'missing';
    detail = `${envVar} is not set, but the configured model (${modelId()}) needs it.`;
    return;
  }
  try {
    await provider.verifyCredentials(modelId());
    state = 'ok';
    detail = '';
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const message = err instanceof Error ? err.message : String(err);
    if (status === 401 || status === 403) {
      state = 'invalid';
      detail = `The API key was rejected by ${provider.id === 'openai' ? 'OpenAI' : 'Anthropic'}. Check ${envVar}.`;
    } else if (status === 404) {
      // Key is fine; the configured model name isn't.
      state = 'ok';
      detail = `Model "${modelId()}" was not found, but the key is valid.`;
    } else {
      state = 'unreachable';
      detail = `Could not reach the ${provider.id === 'openai' ? 'OpenAI' : 'Anthropic'} API: ${message}`;
    }
  }
}
