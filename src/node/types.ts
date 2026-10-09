/** JSON 是持久化及模型边界，SDK 对象不进入会话。 */
export type Mode = 'plan' | 'ask' | 'edit' | 'auto';
export type ProviderName = 'anthropic' | 'openai' | 'mock';
export interface Config {
  workspace: string; home: string; provider: ProviderName; model: string; api_key: string;
  base_url?: string; mode: Mode; max_turns: number; max_stop_blocks: number;
  max_tokens: number; context_chars: number; timeout: number; stream: boolean;
}
export interface Call { id: string; name: string; arguments: any }
export interface Message { role: 'user' | 'assistant' | 'tool'; content: string; tool_calls?: Call[]; tool_call_id?: string; is_error?: boolean }
export interface ToolSpec { name: string; description: string; input_schema: any }
export interface Result { status: string; text: string; reason?: string; turns?: number; session: string; usage?: {input: number; output: number} }
export type Display = (kind: string, text: string) => void;
export type Confirm = (name: string, detail: string) => boolean | Promise<boolean>;
export interface ProviderLike {
  complete(system: string, messages: Message[], tools: ToolSpec[], onText?: (text: string) => void, signal?: AbortSignal): Promise<Reply>;
  close(): void | Promise<void>;
}
export class Reply {
  constructor(public text = '', public calls: Call[] = [], public input_tokens = 0, public output_tokens = 0, public stop = 'stop') {}
  message(): Message { return {role: 'assistant', content: this.text, tool_calls: this.calls}; }
}
export const noop: Display = () => {};
export function errorText(error: unknown): string { return error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
export function cancelled(signal?: AbortSignal): void { signal?.throwIfAborted(); }
