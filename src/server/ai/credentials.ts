import { anthropic, modelId } from './client.js';
import { config, shadowedEnvVars } from '../config.js';

export type KeyState = 'unchecked' | 'ok' | 'missing' | 'invalid' | 'unreachable';

let state: KeyState = config.apiKey ? 'unchecked' : 'missing';
let detail = config.apiKey ? '' : 'ANTHROPIC_API_KEY is not set.';

export function credentialStatus() {
  return { state, detail, shadowedEnvVars };
}

/**
 * Validates the API key at boot against the Models endpoint — a plain GET, so it
 * costs nothing and consumes no tokens. Without this the app cheerfully reports
 * "key configured" for a key the API rejects, and the first failure only shows up
 * inside a run.
 */
export async function verifyCredentials(): Promise<void> {
  if (!config.apiKey) {
    state = 'missing';
    detail = 'ANTHROPIC_API_KEY is not set.';
    return;
  }
  try {
    await anthropic().models.retrieve(modelId());
    state = 'ok';
    detail = '';
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const message = err instanceof Error ? err.message : String(err);
    if (status === 401 || status === 403) {
      state = 'invalid';
      detail = 'The API key was rejected by Anthropic. Check ANTHROPIC_API_KEY.';
    } else if (status === 404) {
      // Key is fine; the configured model name isn't.
      state = 'ok';
      detail = `Model "${modelId()}" was not found, but the key is valid.`;
    } else {
      state = 'unreachable';
      detail = `Could not reach the Anthropic API: ${message}`;
    }
  }
}
