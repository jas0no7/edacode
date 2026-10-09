import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../dist/storage.js';
import { Engine } from '../dist/engine.js';
import { loadConfig } from '../dist/config.js';
import { Reply } from '../dist/types.js';
export class ScriptedProvider {
  requests = [];
  constructor(...replies) { this.replies = replies; }
  async complete(system, messages, tools, onText, signal) {
    this.requests.push({system, messages: structuredClone(messages), tools, signal});
    const reply = this.replies.shift();
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply({system, messages, tools, onText, signal});
    if (!reply) throw new Error('unexpected model request');
    return reply;
  }
  close() {}
}
export const call = (id, name, args = {}) => ({id, name, arguments: args});
export const response = (...calls) => new Reply('', calls);
export const nodeCommand = code => `"${process.execPath}" -e "${code.replaceAll('"', '\\"')}"`;
export async function fixture(t, options = {}, replies) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edacode-test-')));
  const config = {...loadConfig({workspace: root, home: path.join(root, '.state'), provider: 'mock', mode: 'auto', no_stream: true, max_turns: 6}, {}), ...options.config};
  const stores = [], engines = [];
  t.after(async () => { for (const e of engines.reverse()) await e.close(); for (const s of stores.reverse()) await s.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const store = await Store.open(config); stores.push(store);
  await options.setup?.({root, config, store});
  const create = async (engineOptions = {}, selectedStore = store) => {
    const engine = await Engine.create(config, selectedStore, engineOptions); engines.push(engine); return engine;
  };
  const engine = await create(replies ? {provider: new ScriptedProvider(...replies)} : {});
  return {root, config, store, engine, tools: engine.tools, create, stores, write: (file, text) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, text); },
    read: file => fs.readFileSync(path.join(root, file), 'utf8')};
}
