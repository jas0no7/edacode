import { normalizeBaseURL, requireApiConfig } from './config.js';
import type { Config } from './types.js';

export interface ModelInfo { id: string; name?: string }
export type ModelLoader = (config: Config, signal?: AbortSignal) => Promise<ModelInfo[]>;
const MAX_MODELS = 10000;
const MAX_BYTES = 2 * 1024 * 1024;
export async function discoverModels(config: Config, signal?: AbortSignal): Promise<ModelInfo[]> {
  signal?.throwIfAborted(); requireApiConfig(config);
  if (config.provider === 'mock') return [{id: 'mock', name: '离线演示'}];
  const base = normalizeBaseURL(config.provider, config.base_url)
    || (config.provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com');
  const endpoint = new URL(base + (config.provider === 'anthropic' ? '/v1/models' : '/models'));
  const headers: Record<string, string> = {Accept: 'application/json'};
  if (config.provider === 'openai') headers.Authorization = 'Bearer ' + config.api_key;
  else {
    headers['x-api-key'] = config.api_key; headers['anthropic-version'] = '2023-06-01';
    // 部分 Anthropic 中转站的模型列表沿用 OpenAI 的 Bearer 认证。
    if (config.base_url && endpoint.hostname !== 'api.anthropic.com') headers.Authorization = 'Bearer ' + config.api_key;
  }
  const deadline = AbortSignal.timeout(Math.min(config.timeout * 1000, 10000));
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const models = new Map<string, ModelInfo>(), cursors = new Set<string>();
  try {
    for (let page = 0; page < 100; page++) {
      const response = await fetch(endpoint, {headers, signal: combined, redirect: 'error'});
      if (!response.ok) {
        await response.body?.cancel();
        const hint = [401, 403].includes(response.status) ? '请检查 API key 和访问权限'
          : [404, 405, 501].includes(response.status) ? '服务未提供模型列表接口，请手动输入模型 ID' : '请稍后重试或手动输入模型 ID';
        throw new Error(`模型列表请求失败（HTTP ${response.status}）；${hint}`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('模型列表响应为空');
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const {value, done} = await reader.read(); if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_BYTES) throw new Error('模型列表响应过大，请手动输入模型 ID');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      let body: any;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('模型列表响应不是有效 JSON，请手动输入模型 ID'); }
      const rows = Array.isArray(body) ? body : body?.data ?? body?.models;
      if (!Array.isArray(rows)) throw new Error('模型列表响应格式无效，请手动输入模型 ID');
      for (const item of rows) {
        const id = typeof item === 'string' ? item : item?.id;
        if (typeof id !== 'string' || !id || id.length > 512 || /[\s\x00-\x1f\x7f]/.test(id) || id.includes(config.api_key)) continue;
        const name = item?.display_name ?? item?.name;
        models.set(id, {id, ...(typeof name === 'string' && name.length <= 512 && !/[\x00-\x1f\x7f]/.test(name) && !name.includes(config.api_key) ? {name} : {})});
        if (models.size > MAX_MODELS) throw new Error('模型列表过长，请手动输入模型 ID');
      }
      if (config.provider !== 'anthropic' || !body.has_more) return [...models.values()];
      const cursor = body.last_id;
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new Error('模型列表分页游标无效');
      cursors.add(cursor); endpoint.searchParams.set('after_id', cursor);
    }
    throw new Error('模型列表分页过多，请手动输入模型 ID');
  } catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted) throw new Error('获取模型列表超时，请重试或手动输入模型 ID');
    // 网络异常可能包含 URL 或凭据；只展示本模块生成的错误。
    if (error instanceof Error && /^(模型列表|获取模型列表)/.test(error.message)) throw error;
    throw new Error('无法连接模型列表接口，请检查 Base URL 或手动输入模型 ID');
  }
}
export class ModelCatalog {
  private cached?: {provider: Config['provider']; key: string; base?: string; time: number; models: ModelInfo[]};
  constructor(private loader: ModelLoader = discoverModels) {}
  async list(config: Config, signal?: AbortSignal, refresh = false): Promise<ModelInfo[]> {
    signal?.throwIfAborted(); requireApiConfig(config);
    const cached = this.cached;
    if (!refresh && cached && cached.provider === config.provider && cached.key === config.api_key && cached.base === config.base_url && Date.now() - cached.time < 300000) return cached.models;
    // 查询失败后不沿用旧编号，避免列表变化时选错模型。
    this.cached = undefined;
    const models = await this.loader(config, signal);
    signal?.throwIfAborted();
    this.cached = {provider: config.provider, key: config.api_key, base: config.base_url, time: Date.now(), models};
    return models;
  }
}
export function formatModels(models: ModelInfo[], current = ''): string {
  return `当前模型：${current || '未选择'}\n` + (models.length
    ? `可用模型（${models.length}）：\n` + models.map((model, i) => `  ${i + 1}. ${model.id}${model.name && model.name !== model.id ? ` — ${model.name}` : ''}${model.id === current ? ' [当前]' : ''}`).join('\n')
    : '服务未返回可用模型，可手动输入模型 ID。');
}
export function resolveModel(answer: string, models: ModelInfo[]): string {
  const value = answer.trim();
  if (/^\d+$/.test(value) && !models.some(model => model.id === value)) {
    const index = Number(value);
    if (!Number.isSafeInteger(index) || index < 1 || index > models.length) throw new Error('模型编号超出列表范围，请重新运行 /model');
    return models[index - 1].id;
  }
  if (!value || value.length > 512 || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error('模型 ID 必须为不含空白或控制字符的非空字符串');
  return value;
}
