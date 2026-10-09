import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { atomicWrite } from './storage.js';
import { normalizeBaseURL, requireApiConfig } from './config.js';
import { formatModels, resolveModel, type ModelInfo } from './models.js';
import type { Engine } from './engine.js';
import type { Config } from './types.js';

export type ConnectionPrompt = (prompt: string, secret?: boolean) => Promise<string | undefined>;
const begin = '# BEGIN EDACODE CONNECTION';
const end = '# END EDACODE CONNECTION';
const managed = /^# BEGIN EDACODE CONNECTION\r?\n[\s\S]*?^# END EDACODE CONNECTION(?:\r?\n|$)/m;
function envValue(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('配置值不能包含控制字符或换行');
  for (const quote of ["'", '"', '`']) {
    const encoded = quote + value + quote;
    if (!value.includes(quote) && parse('VALUE=' + encoded).VALUE === value) return encoded;
  }
  throw new Error('配置值包含无法保存到 .env 的引号组合');
}
export function saveConnection(config: Config): string {
  requireApiConfig(config);
  const target = path.join(config.home, '.env');
  const original = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  // 只替换向导管理的区块；保留其他配置、注释及已保存的另一 provider 凭据。
  const values = {...parse(original.match(managed)?.[0] || '')};
  const prefix = config.provider === 'openai' ? 'OPENAI' : 'ANTHROPIC';
  Object.assign(values, {EDACODE_PROVIDER: config.provider, EDACODE_MODEL: config.model,
    [`${prefix}_API_KEY`]: config.api_key, [`${prefix}_BASE_URL`]: config.base_url || ''});
  const block = [begin, ...Object.entries(values).map(([key, value]) => `${key}=${envValue(value)}`), end, ''].join('\n');
  const remainder = original.replace(managed, '');
  atomicWrite(target, remainder + (remainder && !remainder.endsWith('\n') ? '\n' : '') + block, 0o600);
  return target;
}
export async function connectModel(engine: Engine, read: ConnectionPrompt, selected?: string): Promise<string> {
  const ask = async (prompt: string, secret = false): Promise<string> => {
    engine.signal.throwIfAborted();
    const answer = await read(prompt, secret);
    engine.signal.throwIfAborted();
    if (answer === undefined) throw new Error('配置已取消，未保存');
    return answer.trim();
  };
  const current = engine.config;
  const choice = selected || await ask(`模型接口：1) Anthropic  2) OpenAI 兼容 [${current.provider === 'openai' ? '2' : '1'}]：`);
  const normalized = choice.toLowerCase();
  const provider = ['1', 'anthropic'].includes(normalized) ? 'anthropic' : ['2', 'openai'].includes(normalized) ? 'openai'
    : !choice ? current.provider === 'openai' ? 'openai' : 'anthropic' : undefined;
  if (!provider) throw new Error('请选择 1 / 2 或 anthropic / openai');
  const same = provider === current.provider;
  const api_key = await ask(`API key（输入隐藏${same && current.api_key ? '，留空保留已有密钥' : ''}）：`, true) || (same ? current.api_key : '');
  if (!api_key) throw new Error('API key 不能为空，未保存');
  envValue(api_key);
  const base = same ? current.base_url : undefined;
  const entered = await ask(`Base URL [${base || '官方默认地址'}]（留空保留，输入 - 恢复官方地址）：`);
  const base_url = normalizeBaseURL(provider, entered === '-' ? undefined : entered || base);
  const next: Config = {...current, provider, api_key, base_url, model: same ? current.model : ''};
  engine.display('info', '正在获取可用模型…');
  let models: ModelInfo[] = [];
  try { models = await engine.modelCatalog.list(next, engine.signal, true); }
  catch (error) {
    engine.signal.throwIfAborted();
    engine.display('info', String(error).replaceAll(api_key, '[REDACTED]'));
  }
  engine.display('info', formatModels(models, next.model));
  const answer = await ask(`选择模型编号或输入模型 ID${next.model ? ` [${next.model}]` : '（留空稍后用 /model 选择）'}：`);
  if (answer) next.model = resolveModel(answer, models);
  engine.signal.throwIfAborted();
  const target = saveConnection(next);
  await engine.connect(next);
  return `已保存模型配置：${target}\n` + (next.model ? `当前会话已切换到 ${provider}/${next.model}` : '接口已配置，输入 /model 选择模型后即可开始任务')
    + '；下次启动仍按环境变量 → 工作区 .env → 用户配置的优先级读取。';
}
export async function chooseModel(engine: Engine, read?: ConnectionPrompt, action = ''): Promise<string> {
  const config = engine.config;
  requireApiConfig(config);
  let models: ModelInfo[] = [];
  const show = !action || action === 'list' || action === 'refresh';
  let failure = '';
  if (show || /^\d+$/.test(action)) {
    try { models = await engine.modelCatalog.list(config, engine.signal, action === 'refresh'); }
    catch (error) {
      engine.signal.throwIfAborted();
      failure = engine.errorText(error);
      if (!show) throw new Error('无法获取模型编号；请运行 /model 重试，或直接输入 /model <模型 ID>');
    }
  }
  if (show) {
    const text = (failure ? failure + '\n' : '') + formatModels(models, config.model);
    if (!read || action === 'list') return text + '\n用 /model <编号或模型 ID> 切换；/model refresh 重新获取列表。';
    engine.display('info', text);
    const answer = await read('选择模型编号或输入模型 ID（留空取消）：');
    engine.signal.throwIfAborted();
    if (!answer?.trim()) return '已取消选择，当前模型未变更。';
    action = answer.trim();
  }
  const model = resolveModel(action, models);
  engine.signal.throwIfAborted();
  // 非 mock 模型的选择保存到与 /connect 相同的用户配置中。
  if (config.provider !== 'mock') saveConnection({...config, model});
  config.model = model;
  return '当前模型：' + model + (config.provider !== 'mock' ? '（已保存）' : '');
}
