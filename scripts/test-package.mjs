/** 用真实 tarball 验证全局安装，不改动用户的 npm 全局环境。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edacode-package-')));
const prefix = path.join(temp, 'global prefix'), workspace = path.join(temp, 'a project 中文'), state = path.join(temp, 'state');
function run(command, args, options = {}) {
  const result = spawn.sync(command, args, {cwd: root, encoding: 'utf8', timeout: 120000, ...options});
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  const packed = run('npm', ['pack', '--json', '--pack-destination', temp]);
  const [info] = JSON.parse(packed.slice(packed.indexOf('[')));
  const allowed = name => name.startsWith('dist/') || ['package.json', '.env.example', 'README.md', 'LICENSE'].includes(name);
  assert.ok(info.files.every(file => allowed(file.path)), 'unexpected file in npm tarball');
  assert.ok(info.files.some(file => file.path === 'dist/cli.js'));
  assert.ok(!info.files.some(file => /(^|\/)\.env$|legacy-v1-backup|session\.json|\.py$/.test(file.path)));
  run('npm', ['install', '--global', '--prefix', prefix, path.join(temp, info.filename), '--no-audit', '--no-fund']);
  const executable = path.join(prefix, process.platform === 'win32' ? 'edacode.cmd' : 'bin/edacode');
  assert.equal(run(executable, ['--version']).trim(), '0.2.0');
  fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'target.txt'), 'workspace data');
  const env = {...process.env, EDACODE_HOME: state, EDACODE_PROVIDER: 'mock', NO_COLOR: '1'};
  const result = JSON.parse(run(executable, ['--provider', 'mock', '--json', '-p', '列出文件'], {cwd: workspace, env}));
  assert.equal(result.status, 'completed'); assert.match(result.text, /target\.txt/);
  const interactive = run(executable, ['--provider', 'mock', '--no-banner'], {cwd: workspace, env, input: '/status\n/quit\n'});
  assert.ok(interactive.includes(workspace)); assert.ok(!interactive.includes('\x1b'));
  const unconfigured = run(executable, ['--provider', 'anthropic', '--no-banner'], {cwd: workspace,
    env: {...env, ANTHROPIC_API_KEY: '', EDACODE_MODEL: '', MODEL_ID: ''}, input: '/status\n/quit\n'});
  assert.match(unconfigured, /未配置/); assert.ok(unconfigured.includes(workspace));
  const overridden = JSON.parse(run(executable, ['--provider', 'mock', '--workspace', workspace, '--json', '-p', '检查'], {cwd: temp, env}));
  assert.match(overridden.text, /target\.txt/);
  assert.equal(fs.existsSync(path.join(workspace, 'node_modules')), false);
  run('npm', ['uninstall', '--global', '--prefix', prefix, 'edacode', '--no-audit', '--no-fund']);
  assert.equal(fs.existsSync(executable), false);
  console.log(`npm tarball ${info.filename}: contents, global command, cwd, Unicode/space paths, REPL, JSON, workspace override and uninstall verified`);
} finally { fs.rmSync(temp, {recursive: true, force: true}); }
