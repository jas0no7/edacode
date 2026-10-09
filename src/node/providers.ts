import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { setTimeout as delay } from 'node:timers/promises';
import { Reply, cancelled, type Config, type Message, type ProviderLike, type ToolSpec } from './types.js';
import { uid } from './storage.js';
import { normalizeBaseURL, requireModelConfig } from './config.js';
export function anthropicMessages(messages: Message[]): any[] {
  const result: any[] = [];
  for (const item of messages) {
    let role: string = item.role; let blocks: any[];
    if (role === 'tool') { role = 'user'; blocks = [{type: 'tool_result', tool_use_id: item.tool_call_id, content: item.content, is_error: item.is_error || false}]; }
    else {
      blocks = item.content ? [{type: 'text', text: item.content}] : [];
      for (const call of item.tool_calls || []) {
        let args = call.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {_invalid_json: args}; } }
        if (!args || typeof args !== 'object' || Array.isArray(args)) args = {_invalid_input: args};
        blocks.push({type: 'tool_use', id: call.id, name: call.name, input: args});
      }
    }
    if (!blocks.length) blocks = [{type: 'text', text: '(空响应)'}];
    if (result.at(-1)?.role === role) result.at(-1).content.push(...blocks); else result.push({role, content: blocks});
  }
  return result;
}
export function openaiMessages(system: string, messages: Message[]): any[] {
  return [{role: 'system', content: system}, ...messages.map(item => {
    const row: any = {role: item.role, content: item.content || ''};
    if (item.role === 'tool') row.tool_call_id = item.tool_call_id;
    if (item.tool_calls?.length) row.tool_calls = item.tool_calls.map(c => ({id: c.id, type: 'function', function: {
      name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments)}}));
    return row;
  })];
}
export class Provider implements ProviderLike {
  client?: Anthropic | OpenAI;
  constructor(public config: Config) {}
  async complete(system: string, messages: Message[], tools: ToolSpec[], onText?: (text: string) => void, signal?: AbortSignal): Promise<Reply> {
    requireModelConfig(this.config);
    if (!this.client) {
      const options = {apiKey: this.config.api_key, baseURL: normalizeBaseURL(this.config.provider, this.config.base_url), timeout: this.config.timeout * 1000, maxRetries: 0};
      this.client = this.config.provider === 'anthropic' ? new Anthropic(options) : new OpenAI(options);
    }
    let emitted = false;
    const emit = onText ? (text: string) => { cancelled(signal); if (text) { emitted = true; onText(text); } } : undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      cancelled(signal);
      try { return this.config.provider === 'anthropic' ? await this.anthropic(system, messages, tools, emit, signal) : await this.openai(system, messages, tools, emit, signal); }
      catch (error: any) {
        cancelled(signal);
        const transient = [408, 429, 500, 502, 503, 504, 529].includes(error.status) || ['APIConnectionError', 'APIConnectionTimeoutError', 'APITimeoutError'].includes(error.name);
        if (!transient || emitted || attempt === 2) throw error;
        await delay(1000 * 2 ** attempt, undefined, {signal});
      }
    }
    throw new Error('unreachable');
  }
  private async anthropic(system: string, messages: Message[], tools: ToolSpec[], onText?: (text: string) => void, signal?: AbortSignal): Promise<Reply> {
    const client = this.client as Anthropic;
    const params: any = {model: this.config.model, system, messages: anthropicMessages(messages), max_tokens: this.config.max_tokens};
    if (tools.length) params.tools = tools;
    let response: any;
    if (this.config.stream && onText) {
      const stream = client.messages.stream(params, {signal}); stream.on('text', onText);
      try { response = await stream.finalMessage(); } finally { stream.abort(); }
    } else response = await client.messages.create(params, {signal});
    const text = response.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    const calls = response.content.filter((b: any) => b.type === 'tool_use').map((b: any) => ({id: b.id, name: b.name, arguments: b.input}));
    const usage = response.usage;
    return new Reply(text, calls, usage.input_tokens + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0), usage.output_tokens, response.stop_reason || 'stop');
  }
  private async openai(system: string, messages: Message[], tools: ToolSpec[], onText?: (text: string) => void, signal?: AbortSignal): Promise<Reply> {
    const client = this.client as OpenAI;
    const params: any = {model: this.config.model, messages: openaiMessages(system, messages), max_tokens: this.config.max_tokens};
    if (tools.length) params.tools = tools.map(t => ({type: 'function', function: {name: t.name, description: t.description, parameters: t.input_schema}}));
    if (!(this.config.stream && onText)) {
      const response: any = await client.chat.completions.create(params, {signal}); const choice = response.choices[0];
      return new Reply(choice.message.content || '', (choice.message.tool_calls || []).map((c: any) => ({id: c.id, name: c.function.name, arguments: c.function.arguments})),
        response.usage?.prompt_tokens || 0, response.usage?.completion_tokens || 0, choice.finish_reason || 'stop');
    }
    let text = '', stop = 'stop', input = 0, output = 0; const calls = new Map<number, any>();
    // 不强制 stream_options，保持与不支持 usage chunk 的网关兼容。
    const stream: any = await client.chat.completions.create({...params, stream: true}, {signal});
    try {
      for await (const chunk of stream) {
        cancelled(signal);
        if (chunk.usage) { input = chunk.usage.prompt_tokens; output = chunk.usage.completion_tokens; }
        const choice = chunk.choices[0]; if (!choice) continue;
        stop = choice.finish_reason || stop; const delta = choice.delta;
        if (delta.content) { text += delta.content; onText(delta.content); }
        for (const part of delta.tool_calls || []) {
          const call = calls.get(part.index) || {id: '', name: '', arguments: ''};
          if (part.id) call.id = part.id;
          if (part.function) { call.name += part.function.name || ''; call.arguments += part.function.arguments || ''; }
          calls.set(part.index, call);
        }
      }
    } finally { stream.controller.abort(); }
    return new Reply(text, [...calls].sort(([a], [b]) => a - b).map(([, c]) => c), input, output, stop);
  }
  close(): void { /* 每次请求由 signal 控制，无驻留 SDK 进程。 */ }
}
export class MockProvider implements ProviderLike {
  async complete(system: string, messages: Message[]): Promise<Reply> {
    if (system.includes('GOAL_EVALUATOR')) return new Reply('{"ok":false,"reason":"mock 无法判断真实任务完成","impossible":true}');
    if (system.includes('CONTEXT_SUMMARIZER')) return new Reply('离线摘要：保留最近消息；更早的完整记录可通过 read_artifact 恢复。');
    const last = messages.at(-1)!;
    if (last.role === 'user') return new Reply('离线演示：调用 list_files 查看工作目录。', [{id: 'mock_' + uid(12), name: 'list_files', arguments: {pattern: '**/*'}}]);
    return new Reply('离线演示完成。真实文件列表：\n' + (last.content || '').slice(0, 2500) + '\n配置 API 后可执行自然语言编码任务。');
  }
  close(): void {}
}
export const makeProvider = (config: Config): ProviderLike => config.provider === 'mock' ? new MockProvider() : new Provider(config);
export { Reply };
