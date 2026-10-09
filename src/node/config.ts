import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { parse } from 'dotenv';
import type { Config } from './types.js';
export function expandHome(value: string): string {
  return value === '~' ? os.homedir() : /^~[\\/]/.test(value) ? path.join(os.homedir(), value.slice(2)) : value;
}
export function realPath(value: string): string {
  const resolved = path.resolve(expandHome(value));
  try { return fs.realpathSync.native(resolved); }
  catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(resolved);
    if (parent === resolved) throw error;
    // 已存在的父目录也必须解析软链接，不能只做字符串归一化。
    return path.join(realPath(parent), path.basename(resolved));
  }
}
export function validateConfig(config: Config): Config {
  config.workspace = realPath(config.workspace); config.home = realPath(config.home);
  if (!fs.statSync(config.workspace).isDirectory()) throw new Error(`工作目录不存在：${config.workspace}`);
  if (!['anthropic', 'openai', 'mock'].includes(config.provider)) throw new Error('provider 必须是 anthropic/openai/mock');
  if (!['plan', 'ask', 'edit', 'auto'].includes(config.mode)) throw new Error('mode 必须是 plan/ask/edit/auto');
  for (const name of ['max_turns', 'max_stop_blocks', 'max_tokens', 'context_chars', 'timeout'] as const) {
    if (!Number.isSafeInteger(config[name]) || config[name] <= 0) throw new Error(`${name} 必须为正整数`);
  }
  if (config.context_chars < 8000) throw new Error('context_chars 不能小于 8000');
  return config;
}
export function modelReady(config: Config): boolean {
  return config.provider === 'mock' || !!(config.model.trim() && config.api_key.trim());
}
export function requireApiConfig(config: Config): void {
  if (config.provider !== 'mock' && !config.api_key.trim()) throw new Error('尚未配置 API key；输入 /connect 配置接口后再选择模型');
}
/** 模型发现与推理使用相同地址，兼容根地址、/v1 和完整接口 URL。 */
export function normalizeBaseURL(provider: Config['provider'], value?: string): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Base URL 必须是有效的 HTTP(S) 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL 必须是 HTTP(S) 地址，不能包含凭据、查询参数或片段');
  }
  let pathname = url.pathname.replace(/\/+$/, '');
  if (provider === 'openai') {
    pathname = pathname.replace(/\/(?:chat\/completions|models)$/, '');
    if (!pathname) pathname = '/v1';
  } else if (provider === 'anthropic') {
    pathname = pathname.replace(/\/(?:messages|models)$/, '').replace(/\/v1$/, '');
  }
  url.pathname = pathname;
  return url.toString().replace(/\/+$/, '');
}
export function requireModelConfig(config: Config): void {
  if (!modelReady(config)) throw new Error(`尚未配置模型或 API key；输入 ${config.api_key.trim() ? '/model 选择模型' : '/connect 完成配置'}，也可在 ${path.join(config.workspace, '.env')} 或 ${path.join(config.home, '.env')} 配置，或使用 --provider mock 离线体验`);
}
export function loadConfig(args: Record<string, any>, env: NodeJS.ProcessEnv = process.env): Config {
  const workspace = realPath(args.workspace ?? '.');
  const home = realPath(args.home || env.EDACODE_HOME || '~/.edacode');
  // 使用独立配置映射，不把项目配置写入宿主进程的环境变量。
  const values = {...env};
  const candidates = args.env_file ? [path.resolve(expandHome(args.env_file))] : [path.join(workspace, '.env'), path.join(home, '.env')];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) { if (args.env_file) throw new Error(`env 文件不存在：${candidate}`); continue; }
    for (const [key, value] of Object.entries(parse(fs.readFileSync(candidate)))) if (values[key] === undefined) values[key] = value;
  }
  const provider = args.provider || values.EDACODE_PROVIDER || 'anthropic';
  const prefix = provider === 'openai' ? 'OPENAI' : 'ANTHROPIC';
  const integer = (name: string, fallback: number) => values[name] === undefined ? fallback : Number(values[name]);
  return validateConfig({ workspace, home, provider, model: args.model || values.EDACODE_MODEL || values.MODEL_ID || '',
    api_key: values[`${prefix}_API_KEY`] || '', base_url: normalizeBaseURL(provider, values[`${prefix}_BASE_URL`]),
    mode: args.mode || values.EDACODE_MODE || 'edit', max_turns: args.max_turns ?? integer('EDACODE_MAX_TURNS', 40),
    max_stop_blocks: integer('EDACODE_MAX_STOP_BLOCKS', 5), max_tokens: integer('EDACODE_MAX_TOKENS', 8192),
    context_chars: integer('EDACODE_CONTEXT_CHARS', 120000), timeout: integer('EDACODE_TIMEOUT', 120), stream: !args.no_stream });
}
