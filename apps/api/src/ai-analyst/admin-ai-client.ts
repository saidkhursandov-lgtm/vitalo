import Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';

/**
 * Генплан, этап 5, ветка admin-ai-analyst (D-57, узел 5): the second Claude contour, for the admin only. Its own key
 * ANTHROPIC_ADMIN_API_KEY (the owner puts it into .env; never into git, chat or the admin panel), its own budget —
 * so the analyst can never spend the money of VITALO AI for customers and the other way round.
 */

export interface AdminAiUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AdminAiAnswer extends AdminAiUsage {
  text: string;
  /** with a schema: the parsed JSON, or null when the model gave none */
  json: unknown;
  outcome: 'ok' | 'refusal' | 'max_tokens' | 'not_json';
}

export interface AdminAiCall {
  model: string;
  /** stable instructions — cached */
  system: string;
  /** shop data for this call (products, memory) — cached too: several questions in a row reuse it */
  context: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  schema?: Record<string, unknown>;
  maxTokens: number;
  effort: 'low' | 'medium' | 'high';
}

export interface AdminAiModel {
  /** false — no ANTHROPIC_ADMIN_API_KEY in .env: the analyst is off */
  ready(): boolean;
  ask(call: AdminAiCall): Promise<AdminAiAnswer>;
}

export const ADMIN_AI_MODEL = Symbol('ADMIN_AI_MODEL');

/** A failed call: timeout | rate_limit | api_<status> | network. Never holds the request text. */
export class AdminAiCallError extends Error {
  constructor(readonly code: string) {
    super(`Admin AI call failed: ${code}`);
  }
}

@Injectable()
export class AnthropicAdminModel implements AdminAiModel {
  private client: Anthropic | null = null;

  private key(): string {
    return process.env.ANTHROPIC_ADMIN_API_KEY?.trim() ?? '';
  }

  ready(): boolean {
    return !!this.key();
  }

  private api(): Anthropic {
    // the admin waits at the screen: 3 minutes for a long answer, one retry
    this.client ??= new Anthropic({ apiKey: this.key(), timeout: 180_000, maxRetries: 1 });
    return this.client;
  }

  async ask(call: AdminAiCall): Promise<AdminAiAnswer> {
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.api().beta.messages.create({
        model: call.model,
        max_tokens: call.maxTokens,
        // a refusal of the main model goes to a fallback model on Anthropic's side (cost is counted by res.model)
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [
          { type: 'text', text: call.system, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: call.context, cache_control: { type: 'ephemeral' } },
        ],
        messages: call.messages,
        output_config: call.schema ? { effort: call.effort, format: { type: 'json_schema', schema: call.schema } } : { effort: call.effort },
      });
    } catch (e) {
      if (e instanceof Anthropic.APIConnectionTimeoutError) throw new AdminAiCallError('timeout');
      if (e instanceof Anthropic.RateLimitError) throw new AdminAiCallError('rate_limit');
      if (e instanceof Anthropic.APIError && e.status) throw new AdminAiCallError(`api_${e.status}`);
      throw new AdminAiCallError('network');
    }
    const usage: AdminAiUsage = {
      model: res.model,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
    };
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    if (res.stop_reason === 'refusal') return { ...usage, text: '', json: null, outcome: 'refusal' };
    if (res.stop_reason === 'max_tokens') return { ...usage, text, json: null, outcome: 'max_tokens' };
    if (!call.schema) return { ...usage, text, json: null, outcome: 'ok' };
    try {
      return { ...usage, text, json: JSON.parse(text), outcome: 'ok' };
    } catch {
      return { ...usage, text, json: null, outcome: 'not_json' };
    }
  }
}
