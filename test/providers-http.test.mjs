import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fixture, nodeCommand } from './helpers.mjs';
import { Provider } from '../dist/providers.js';
import { assertProtocol } from '../dist/context.js';
async function serve(t, handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    await handler(JSON.parse(Buffer.concat(chunks).toString('utf8')), req, res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
function openai(index, action, stream) {
  const text = '已验证 sample.value == 2';
  const calls = action ? [{id: `call_${index}`, type: 'function', function: {name: action[0], arguments: JSON.stringify(action[1])}}] : [];
  const finish = action ? 'tool_calls' : 'stop', base = {id: `chat_${index}`, created: 1, model: 'local-test'};
  if (!stream) return JSON.stringify({...base, object: 'chat.completion', choices: [{index: 0, finish_reason: finish,
    message: {role: 'assistant', content: action ? '' : text, tool_calls: calls}}], usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}});
  let deltas;
  if (action) { const args = calls[0].function.arguments, split = Math.floor(args.length / 2); deltas = [
    {role: 'assistant', tool_calls: [{index: 0, id: `call_${index}`, type: 'function', function: {name: action[0], arguments: args.slice(0, split)}}]},
    {tool_calls: [{index: 0, function: {arguments: args.slice(split)}}]}];
  } else deltas = [{role: 'assistant', content: text.slice(0, 4)}, {content: text.slice(4)}];
  const chunks = deltas.map(delta => ({...base, object: 'chat.completion.chunk', choices: [{index: 0, delta, finish_reason: null}]}));
  chunks.push({...base, object: 'chat.completion.chunk', choices: [{index: 0, delta: {}, finish_reason: finish}]});
  return chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n';
}
function anthropic(index, action, stream) {
  const block = action ? {type: 'tool_use', id: `call_${index}`, name: action[0], input: action[1]} : {type: 'text', text: '已验证 sample.value == 2'};
  const finish = action ? 'tool_use' : 'end_turn';
  const message = {id: `msg_${index}`, type: 'message', role: 'assistant', model: 'local-test', content: [block], stop_reason: finish, stop_sequence: null, usage: {input_tokens: 10, output_tokens: 5}};
  if (!stream) return JSON.stringify(message);
  const raw = action ? JSON.stringify(action[1]) : block.text, mid = Math.floor(raw.length / 2);
  const events = [{type: 'message_start', message: {...message, content: [], stop_reason: null, usage: {input_tokens: 10, output_tokens: 0}}},
    {type: 'content_block_start', index: 0, content_block: action ? {...block, input: {}} : {type: 'text', text: ''}}];
  for (const fragment of [raw.slice(0, mid), raw.slice(mid)]) events.push({type: 'content_block_delta', index: 0,
    delta: action ? {type: 'input_json_delta', partial_json: fragment} : {type: 'text_delta', text: fragment}});
  events.push({type: 'content_block_stop', index: 0}, {type: 'message_delta', delta: {stop_reason: finish, stop_sequence: null}, usage: {output_tokens: 5}}, {type: 'message_stop'});
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}
for (const provider of ['anthropic', 'openai']) for (const stream of [false, true]) test(`${provider} SDK 本地 ${stream ? 'SSE' : 'HTTP'} 完整编码循环`, async t => {
  const requests = [], actions = [['write_file', {path: 'sample.js', content: 'module.exports.value = 1;\n'}], ['read_file', {path: 'sample.js'}],
    ['edit_file', {path: 'sample.js', old_text: 'value = 1', new_text: 'value = 2'}], ['shell', {command: nodeCommand("const m=require('./sample.js');if(m.value!==2)process.exit(1);console.log('verified')")}]];
  const base = await serve(t, async (data, req, res) => {
    const index = requests.length; requests.push({url: req.url, data});
    const payload = provider === 'anthropic' ? anthropic(index, actions[index], data.stream) : openai(index, actions[index], data.stream);
    res.writeHead(200, {'content-type': data.stream ? 'text/event-stream' : 'application/json'}); res.end(payload);
  });
  const f = await fixture(t, {config: {provider, stream, api_key: 'local-test-only', model: 'local-test', base_url: base + (provider === 'openai' ? '/v1' : ''), timeout: 5}});
  const displayed = []; f.engine.display = (kind, text) => displayed.push([kind, text]);
  const result = await f.engine.run('创建、读取、修改 sample.js，执行断言'); assert.equal(result.status, 'completed', result.reason);
  assert.equal(f.read('sample.js'), 'module.exports.value = 2;\n'); const outputs = f.engine.messages.filter(m => m.role === 'tool'); assert.equal(outputs.length, 4); assert.ok(outputs.every(m => !m.is_error));
  assert.match(outputs.at(-1).content, /verified/); assert.equal(requests.length, 5); assert.deepEqual(new Set(requests.map(r => r.url)), new Set([provider === 'anthropic' ? '/v1/messages' : '/v1/chat/completions']));
  const wire = requests.at(-1).data.messages;
  assert.equal(provider === 'openai' ? wire.filter(m => m.role === 'tool').length : wire.flatMap(m => m.content).filter(b => b.type === 'tool_result').length, 4);
  if (stream) assert.equal(displayed.filter(([kind]) => kind === 'stream').map(([, text]) => text).join(''), result.text);
  if (!stream || provider === 'anthropic') assert.equal(f.store.data.usage.input, 50);
  assertProtocol(f.engine.messages);
});
test('429 在未显示输出前重试，SDK 自身重试关闭', async t => {
  let count = 0;
  const base = await serve(t, async (_, req, res) => { count++; if (count === 1) { res.writeHead(429, {'content-type': 'application/json'}); res.end('{"error":{"message":"rate limit","type":"rate_limit_error"}}'); }
    else { res.writeHead(200, {'content-type': 'application/json'}); res.end(openai(0, undefined, false)); } });
  const f = await fixture(t, {config: {provider: 'openai', api_key: 'local', model: 'local', base_url: base + '/v1', stream: false, timeout: 3}});
  assert.equal((await f.engine.run('请求')).status, 'completed'); assert.equal(count, 2);
});
test('已经显示流式文本后网络失败不重试', async t => {
  let count = 0;
  const base = await serve(t, async (_, req, res) => {
    count++; res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write('data: ' + JSON.stringify({id: 'chat', object: 'chat.completion.chunk', choices: [{index: 0, delta: {content: 'partial'}, finish_reason: null}]}) + '\n\n');
    setTimeout(() => res.destroy(), 50);
  });
  const f = await fixture(t, {config: {provider: 'openai', api_key: 'local', model: 'local', base_url: base + '/v1', stream: true, timeout: 3}});
  const displayed = []; f.engine.display = (kind, text) => displayed.push([kind, text]); assert.equal((await f.engine.run('请求')).status, 'error'); assert.equal(count, 1); assert.equal(displayed.find(([kind]) => kind === 'stream')[1], 'partial');
});
