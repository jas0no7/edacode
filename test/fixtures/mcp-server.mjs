import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
for await (const line of readline.createInterface({input: process.stdin})) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({jsonrpc: '2.0', id: message.id, result: {protocolVersion: '2024-11-05', capabilities: {tools: {}}, serverInfo: {name: 'echo', version: '1'}}});
  if (message.method === 'tools/list') send({jsonrpc: '2.0', id: message.id, result: {tools: [{name: 'echo', description: 'echo test', inputSchema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text'], additionalProperties: false}}, {name: 'fail', inputSchema: {type: 'object', properties: {}}}, {name: 'wait', inputSchema: {type: 'object', properties: {}}}]}});
  if (message.method === 'tools/call') {
    if (message.params.name === 'wait') continue;
    send({jsonrpc: '2.0', id: message.id, result: {isError: message.params.name === 'fail', content: [{type: 'text', text: message.params.name === 'fail' ? 'failed' : 'echo:' + message.params.arguments.text}]}});
  }
}
