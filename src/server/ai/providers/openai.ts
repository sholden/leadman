import OpenAI from 'openai';
import type { FunctionTool, ResponseInput, Tool } from 'openai/resources/responses/responses';
import { config } from '../../config.js';
import { getSetting, getNumberSetting } from '../../db/index.js';
import { fetchReadable } from '../../lib/archive.js';
import { ProviderRefusalError } from './types.js';
import type { LlmProvider, NormalizedUsage, StructuredRequest } from './types.js';

let client: OpenAI | null = null;

function openaiClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: config.openaiApiKey || undefined,
      timeout: 20 * 60 * 1000,
      maxRetries: 3,
    });
  }
  return client;
}

function effortLevel(): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  const e = getSetting('effort');
  return (['low', 'medium', 'high', 'xhigh', 'max'] as const).includes(e as never)
    ? (e as 'high')
    : 'high';
}

/**
 * OpenAI has no hosted equivalent of Anthropic's web_fetch, so URL reading is a
 * client-side tool backed by our own fetcher. That is not a downgrade: the same
 * code powers the archive, so this path gets HTML-to-text and real PDF text
 * extraction, which matters because council agendas are almost always PDFs.
 */
const FETCH_TOOL_NAME = 'fetch_url';

function fetchTool(): Tool {
  return {
    type: 'function',
    name: FETCH_TOOL_NAME,
    description:
      'Fetch a web page or PDF and return its readable text. Use this to open any URL ' +
      'you want to read in full, including agenda PDFs found via web search.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL to fetch.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  };
}

function normalizeUsage(u: OpenAI.Responses.ResponseUsage | undefined, searches: number): NormalizedUsage {
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  return {
    // OpenAI reports cached tokens inside input_tokens; split them so the shared
    // cost model prices them at the cached rate rather than full.
    inputTokens: Math.max(0, (u?.input_tokens ?? 0) - cached),
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    webSearchRequests: searches,
  };
}

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
  const maxDocChars = getNumberSetting('webFetchMaxContentTokens') * 4; // ~4 chars/token
  const maxFetches = getNumberSetting('webFetchMaxUses');

  const submitTool: Tool = {
    type: 'function',
    name: toolName,
    description: toolDescription,
    strict: true,
    parameters: inputSchema as FunctionTool['parameters'],
  };

  const tools: Tool[] = research
    ? [
        {
          type: 'web_search',
          // The app's cost dial: how much page context each search pulls in.
          search_context_size: getNumberSetting('webFetchMaxContentTokens') > 30_000 ? 'high' : 'medium',
        },
        fetchTool(),
        submitTool,
      ]
    : [submitTool];

  const input: ResponseInput = [
    { role: 'system', content: system },
    { role: 'user', content: prompt },
  ];

  let fetchesUsed = 0;
  let searchesUsed = 0;
  let nudged = false;

  for (let i = 0; i < maxIterations; i++) {
    budget.assertCanSpend();

    const response = await openaiClient().responses.create({
      model,
      input,
      tools,
      max_output_tokens: maxTokens,
      reasoning: { effort },
      store: false,
    });

    const searchesThisTurn = response.output.filter((o) => o.type === 'web_search_call').length;
    searchesUsed += searchesThisTurn;
    budget.record(purpose, model, normalizeUsage(response.usage, searchesThisTurn));

    if (response.status === 'incomplete' && response.incomplete_details?.reason === 'content_filter') {
      throw new ProviderRefusalError('The model declined this request (content filter).');
    }

    const calls = response.output.filter(
      (o): o is Extract<typeof o, { type: 'function_call' }> => o.type === 'function_call',
    );

    // Carry the model's own output forward, then append our tool results.
    input.push(...(response.output as ResponseInput));

    const submit = calls.find((c) => c.name === toolName);
    if (submit) {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(submit.arguments);
      } catch {
        parsedJson = null;
      }
      const parsed = validator.safeParse(parsedJson);
      if (parsed.success) return parsed.data;

      if (response.status === 'incomplete') {
        console.warn(
          `[ai] ${purpose}: hit max_output_tokens (${maxTokens}) mid-submission; retrying.`,
        );
      }
      input.push({
        type: 'function_call_output',
        call_id: submit.call_id,
        output: `Your submission did not validate: ${
          parsed.error?.issues
            .map((iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`)
            .join('; ') ?? 'invalid JSON'
        }. Call ${toolName} again with corrected values.`,
      });
      continue;
    }

    const fetches = calls.filter((c) => c.name === FETCH_TOOL_NAME);
    if (fetches.length > 0) {
      for (const call of fetches) {
        let output: string;
        if (fetchesUsed >= maxFetches) {
          output = `Fetch limit of ${maxFetches} documents reached for this task. Work with what you have and call ${toolName} now.`;
        } else {
          fetchesUsed++;
          let url = '';
          try {
            url = String((JSON.parse(call.arguments) as { url?: string }).url ?? '');
          } catch {
            /* fall through to the empty-url error below */
          }
          if (!url) {
            output = 'Error: no url argument supplied.';
          } else {
            const doc = await fetchReadable(url, maxDocChars);
            output = doc.text
              ? `# ${doc.title || url}\n(${doc.contentType || 'unknown type'}, ${doc.bytes} bytes)\n\n${doc.text}`
              : `[no readable content at ${url}]`;
          }
        }
        input.push({ type: 'function_call_output', call_id: call.call_id, output });
      }
      continue;
    }

    if (calls.length > 0) {
      for (const call of calls) {
        input.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: `Unknown tool. Call ${toolName} to finish.`,
        });
      }
      continue;
    }

    // Searched or reasoned but called nothing — let it continue once, then nudge.
    if (searchesThisTurn > 0 && !nudged) continue;

    if (nudged) throw new Error(`${purpose}: model ended without calling ${toolName}.`);
    nudged = true;
    input.push({
      role: 'user',
      content: `You must now call the ${toolName} tool with your results. Do not reply with prose. If you found nothing, call it with empty arrays.`,
    });
  }

  throw new Error(`${purpose}: exceeded ${maxIterations} iterations without a result.`);
}

export const openaiProvider: LlmProvider = {
  id: 'openai',
  async availableModels() {
    if (!config.openaiApiKey) return [];
    const page = await openaiClient().models.list();
    const ids = page.data.map((m) => m.id);
    // The account exposes ~127 models; most are audio, image, embedding, or
    // coding-agent variants that cannot drive this app's tool loop.
    const excluded =
      /embed|whisper|tts|audio|image|dall-e|moderation|sora|realtime|transcribe|codex|search-api|search-preview|instruct|davinci|babbage|chat-latest|-\d{4}-\d{2}-\d{2}$/i;
    return ids
      .filter((id) => /^(gpt-5|o[34])/i.test(id) && !excluded.test(id))
      .sort()
      .reverse();
  },
  hasApiKey: () => Boolean(config.openaiApiKey),
  /** Models endpoint is a plain GET — validates the key without spending tokens. */
  async verifyCredentials(model: string) {
    await openaiClient().models.retrieve(model);
  },
  runStructured,
};
