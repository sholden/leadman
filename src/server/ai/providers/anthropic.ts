import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaTool as Tool,
  BetaToolUnion as ToolUnion,
  BetaMessageParam as MessageParam,
  BetaContentBlockParam as ContentBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages';
import { z } from 'zod';
import { config } from '../../config.js';
import { getSetting, getNumberSetting } from '../../db/index.js';
import type { StructuredRequest, LlmProvider, NormalizedUsage } from './types.js';
import { ProviderRefusalError } from './types.js';

let client: Anthropic | null = null;

function anthropicClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: config.apiKey || undefined,
      // Agentic turns with web search can run for many minutes.
      timeout: 20 * 60 * 1000,
      maxRetries: 3,
    });
  }
  return client;
}

/**
 * Server-side research tools. Dynamic filtering is built in; do not add code_execution.
 *
 * Built per call from settings because these caps are the app's main cost dial —
 * lowering them trades coverage breadth for spend, without touching reasoning quality.
 */
export function researchTools(): ToolUnion[] {
  return [
    {
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: getNumberSetting('webSearchMaxUses'),
    } as ToolUnion,
    {
      type: 'web_fetch_20260209',
      name: 'web_fetch',
      max_uses: getNumberSetting('webFetchMaxUses'),
      max_content_tokens: getNumberSetting('webFetchMaxContentTokens'),
    } as ToolUnion,
  ];
}

/**
 * Runs one agentic turn and returns validated structured output.
 *
 * The model gets the Anthropic-hosted web_search/web_fetch tools plus exactly one
 * client-side "submit" tool. We loop until it calls submit (or we run out of
 * iterations/budget). Using a strict tool as the output channel — rather than
 * output_config.format — keeps structured output working alongside server tools.
 */
async function runStructured<T>(opts: StructuredRequest<T>): Promise<T> {
  const {
    purpose,
    system,
    prompt,
    toolName,
    toolDescription,
    inputSchema,
    validator,
    budget,
    research = false,
    maxTokens = 32_000,
    maxIterations = 12,
  } = opts;

  const model = getSetting('model');
  const effort = opts.effort ?? effortLevel();

  // The pre-call budget guard cannot bound a call that is already running, and one
  // agentic turn reading a dozen PDFs can cost several dollars on its own. A task
  // budget tells the model its token allowance up front so it paces itself and
  // wraps up, rather than being cut off. Sized from whatever run budget is left.
  const taskBudgetTokens = budget.remainingTokenAllowance();

  const submitTool: Tool = {
    name: toolName,
    description: toolDescription,
    strict: true,
    input_schema: inputSchema as Tool['input_schema'],
  };

  const tools: ToolUnion[] = research ? [...researchTools(), submitTool] : [submitTool];
  const messages: MessageParam[] = [{ role: 'user', content: prompt }];

  let nudged = false;

  for (let i = 0; i < maxIterations; i++) {
    budget.assertCanSpend();

    const stream = anthropicClient().beta.messages.stream({
      model,
      max_tokens: maxTokens,
      system,
      tools,
      thinking: { type: 'adaptive' },
      output_config: {
        effort,
        task_budget: { type: 'tokens', total: taskBudgetTokens },
      },
      betas: ['task-budgets-2026-03-13'],
      messages,
    });
    const response = await stream.finalMessage();
    budget.record(purpose, model, normalizeUsage(response.usage));

    if (response.stop_reason === 'refusal') {
      throw new ProviderRefusalError(
        `Model declined this request (${response.stop_details?.category ?? 'unspecified'}).`,
      );
    }

    // A long server-tool turn can pause; re-send to let the server resume.
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }

    const submit = response.content.find(
      (b): b is Extract<typeof b, { type: 'tool_use' }> =>
        b.type === 'tool_use' && b.name === toolName,
    );
    if (submit) {
      const parsed = validator.safeParse(submit.input);
      if (parsed.success) return parsed.data;

      // A truncated tool call is almost always max_tokens rather than a real schema
      // disagreement. Say so, because the fix is a bigger budget, not a better prompt.
      if (response.stop_reason === 'max_tokens') {
        console.warn(
          `[ai] ${purpose}: hit max_tokens (${maxTokens}) mid-submission; retrying. ` +
            `Raise maxTokens for this call if it recurs — thinking counts against it.`,
        );
      }

      // Schema drift: tell the model exactly what was wrong and let it retry.
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: submit.id,
            is_error: true,
            content: `Your submission did not validate: ${parsed.error.issues
              .map((iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`)
              .join('; ')}. Call ${toolName} again with corrected values.`,
          } as ContentBlockParam,
        ],
      });
      continue;
    }

    // Any other client tool_use shouldn't happen — submit is the only one we define.
    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });
      const results: ContentBlockParam[] = response.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          type: 'tool_result',
          tool_use_id: (b as { id: string }).id,
          is_error: true,
          content: `Unknown tool. Call ${toolName} to finish.`,
        }));
      messages.push({ role: 'user', content: results });
      continue;
    }

    if (response.stop_reason === 'max_tokens') {
      throw new Error(`${purpose}: response hit max_tokens before submitting results.`);
    }

    // Ended its turn with prose instead of calling submit. Nudge once.
    if (nudged) {
      throw new Error(`${purpose}: model ended without calling ${toolName}.`);
    }
    nudged = true;
    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content: `You must now call the ${toolName} tool with your results. Do not reply with prose. If you found nothing, call it with empty arrays.`,
    });
  }

  throw new Error(`${purpose}: exceeded ${maxIterations} iterations without a result.`);
}

function effortLevel(): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  const e = getSetting('effort');
  return (['low', 'medium', 'high', 'xhigh', 'max'] as const).includes(e as never)
    ? (e as 'high')
    : 'high';
}

function normalizeUsage(u: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}): NormalizedUsage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    webSearchRequests: u.server_tool_use?.web_search_requests ?? 0,
  };
}

export const anthropicProvider: LlmProvider = {
  id: 'anthropic',
  async availableModels() {
    if (!config.apiKey) return [];
    const page = await anthropicClient().models.list({ limit: 100 });
    // Newest first is the order the API returns; keep it.
    return page.data.map((m) => m.id);
  },
  hasApiKey: () => Boolean(config.apiKey),
  /** Models endpoint is a plain GET — validates the key without spending tokens. */
  async verifyCredentials(model: string) {
    await anthropicClient().models.retrieve(model);
  },
  runStructured,
};
