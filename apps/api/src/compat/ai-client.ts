import Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';

/** What the service asks the model and gets back; the tests put a fake in its place. */
export interface AiCompletion {
  /** the parsed JSON answer, or null when the model gave none (refusal, cut off, not JSON) */
  json: unknown;
  inputTokens: number;
  outputTokens: number;
  /** ok | refusal | max_tokens | not_json */
  outcome: 'ok' | 'refusal' | 'max_tokens' | 'not_json';
}

export interface AiModel {
  /** false — no ANTHROPIC_API_KEY: every request goes to the specialist */
  ready(): boolean;
  complete(input: { model: string; system: string; data: string; schema: Record<string, unknown>; maxTokens: number }): Promise<AiCompletion>;
}

export const AI_MODEL = Symbol('AI_MODEL');

/** A failed call: timeout | rate_limit | api_<status> | network. Never holds the request text. */
export class AiCallError extends Error {
  constructor(readonly code: string) {
    super(`VITALO AI call failed: ${code}`);
  }
}

/**
 * The Claude API (Anthropic SDK). The key is read from ANTHROPIC_API_KEY in .env only. One retry, 20 s per attempt:
 * the customer waits with the animation, a slow answer goes to the specialist instead.
 */
@Injectable()
export class AnthropicModel implements AiModel {
  private client: Anthropic | null = null;

  ready(): boolean {
    return !!process.env.ANTHROPIC_API_KEY?.trim();
  }

  private api(): Anthropic {
    this.client ??= new Anthropic({ timeout: 20_000, maxRetries: 1 });
    return this.client;
  }

  async complete(input: { model: string; system: string; data: string; schema: Record<string, unknown>; maxTokens: number }): Promise<AiCompletion> {
    let res: Anthropic.Message;
    try {
      res = await this.api().messages.create({
        model: input.model,
        max_tokens: input.maxTokens,
        system: input.system,
        messages: [{ role: 'user', content: input.data }],
        output_config: { effort: 'low', format: { type: 'json_schema', schema: input.schema } },
      });
    } catch (e) {
      if (e instanceof Anthropic.APIConnectionTimeoutError) throw new AiCallError('timeout');
      if (e instanceof Anthropic.RateLimitError) throw new AiCallError('rate_limit');
      if (e instanceof Anthropic.APIError && e.status) throw new AiCallError(`api_${e.status}`);
      throw new AiCallError('network');
    }
    const usage = { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
    if (res.stop_reason === 'refusal') return { json: null, ...usage, outcome: 'refusal' };
    if (res.stop_reason === 'max_tokens') return { json: null, ...usage, outcome: 'max_tokens' };
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    try {
      return { json: JSON.parse(text), ...usage, outcome: 'ok' };
    } catch {
      return { json: null, ...usage, outcome: 'not_json' };
    }
  }
}
