// Contract tests for every registered provider, plus parser fixtures per CLI: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, getProvider } from './index.ts';
import { parseModels } from './opencode.ts';
import type { Agent, Task } from '../../../shared/types.ts';
import type { ProviderEvent, RunContext } from './types.ts';

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'a1', name: 'Ada', kind: 'agent', provider: 'claude', role: 'Dev', color: '#fff', prompt: '', model: '', cwd: '', permissionMode: 'acceptEdits',
  allowedTools: '', team: '', sessionId: null, totalCost: 0, hiredAt: 0, ...over,
});
const task: Task = { id: 't1', agentId: 'a1', prompt: 'do it', from: 'user', parentId: null, depth: 0, kind: 'task', status: 'queued', createdAt: 0, startedAt: null, endedAt: null, result: '', cost: 0 };
const ctx = (over: Partial<Agent> = {}): RunContext => ({
  agent: agent(over), task, cwd: '/work', systemPrompt: 'PERSONA',
  mcp: { command: '/bin/tsx', args: ['/x/office-mcp.ts'], env: { OFFICE_URL: 'http://127.0.0.1:1', AGENT_ID: 'a1', TASK_ID: 't1' } },
});
const feed = (id: string, lines: object[]): ProviderEvent[] => {
  const parse = getProvider(id).createParser();
  return lines.flatMap((l) => parse(JSON.stringify(l)));
};

for (const p of PROVIDERS) {
  test(`${p.id}: provider contract`, () => {
    assert.match(p.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(p.label && p.binaryNames.length);
    assert.equal(PROVIDERS.filter((q) => q.id === p.id).length, 1, 'duplicate provider id');
    const args = p.buildArgs(ctx());
    assert.ok(args.length && args.every((a) => typeof a === 'string'));
    assert.ok(args.some((a) => a.includes('do it')), 'task prompt must be passed to the CLI');
    assert.ok(args.some((a) => a.includes('PERSONA')), 'persona must reach the CLI');
    const parse = p.createParser();
    assert.deepEqual(parse('not json'), []);
    assert.deepEqual(parse('{"type":"something-unknown"}'), []);
    assert.deepEqual(parse('42'), []);
  });
}

test('unknown provider ids fall back to claude', () => {
  assert.equal(getProvider('nope').id, 'claude');
  assert.equal(getProvider(undefined).id, 'claude');
});

test('claude: events and resume', () => {
  const events = feed('claude', [
    { type: 'system', subtype: 'init', session_id: 's1' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'boom' }] } },
    { type: 'result', is_error: false, result: 'done', total_cost_usd: 0.5 },
  ]);
  assert.deepEqual(events.map((e) => e.type), ['session', 'text', 'tool', 'tool-error', 'result']);
  assert.deepEqual(events.at(-1), { type: 'result', ok: true, text: 'done', costUsd: 0.5 });
  assert.ok(getProvider('claude').buildArgs(ctx({ sessionId: 's1' })).includes('--resume'));
});

test('cursor: events, resume and permissions', () => {
  const events = feed('cursor', [
    { type: 'system', subtype: 'init', session_id: 'c1' },
    { type: 'thinking', subtype: 'delta', text: 'x' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } },
    { type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: { args: { command: 'ls' } } } },
    { type: 'result', subtype: 'success', is_error: false, result: 'Hi' },
  ]);
  assert.deepEqual(events.map((e) => e.type), ['session', 'text', 'tool', 'result']);
  const p = getProvider('cursor');
  assert.ok(p.buildArgs(ctx({ permissionMode: 'bypassPermissions' })).includes('--force'));
  const resumed = p.buildArgs(ctx({ sessionId: 'c1' }));
  assert.equal(resumed[resumed.indexOf('--resume') + 1], 'c1');
  assert.equal(p.delegation, false);
});

test('codex: current and legacy event formats', () => {
  const current = feed('codex', [
    { type: 'thread.started', thread_id: 'th1' },
    { type: 'item.started', item: { type: 'command_execution', command: 'ls' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
    { type: 'turn.completed', usage: {} },
  ]);
  assert.deepEqual(current.map((e) => e.type), ['session', 'tool', 'text', 'result']);
  assert.deepEqual(current.at(-1), { type: 'result', ok: true, text: 'ok' });

  const legacy = feed('codex', [
    { id: '0', msg: { type: 'session_configured', session_id: 'th2' } },
    { id: '1', msg: { type: 'agent_message', message: 'ok' } },
    { id: '2', msg: { type: 'task_complete', last_agent_message: 'ok' } },
  ]);
  assert.deepEqual(legacy.map((e) => e.type), ['session', 'text', 'result']);

  const failed = feed('codex', [{ type: 'turn.failed', error: { message: 'nope' } }]);
  assert.deepEqual(failed, [{ type: 'result', ok: false, text: 'nope' }]);
});

test('codex: sandbox flags, MCP config and resume', () => {
  const p = getProvider('codex');
  const args = p.buildArgs(ctx());
  assert.equal(args[0], 'exec');
  assert.ok(args.includes('--full-auto') && args.includes('--json'));
  assert.ok(args.includes('mcp_servers.office.command="/bin/tsx"'));
  assert.ok(p.buildArgs(ctx({ permissionMode: 'plan' })).includes('read-only'));
  const resumed = p.buildArgs(ctx({ sessionId: 'th1' }));
  assert.equal(resumed[resumed.indexOf('resume') + 1], 'th1');
});

test('opencode: models come from `opencode models`', () => {
  const models = parseModels('anthropic/claude-sonnet-4-5\nopenai/gpt-5\nnot a model\n\nanthropic/claude-sonnet-4-5\n');
  assert.deepEqual(models, [
    { value: 'anthropic/claude-sonnet-4-5', label: 'anthropic/claude-sonnet-4-5' },
    { value: 'openai/gpt-5', label: 'openai/gpt-5' },
  ]);
  assert.ok(getProvider('opencode').listModels);
  // CLIs without a listing command keep their static suggestions
  assert.equal(getProvider('claude').listModels, undefined);
});

test('a failed claude run keeps its cost; a result without the field is unknown, not $0', () => {
  assert.deepEqual(feed('claude', [{ type: 'result', is_error: true, result: 'boom', total_cost_usd: 0.4 }]), [{ type: 'result', ok: false, text: 'boom', costUsd: 0.4 }]);
  assert.deepEqual(feed('claude', [{ type: 'result', is_error: true, result: 'boom' }]), [{ type: 'result', ok: false, text: 'boom' }]);
  assert.deepEqual(feed('claude', [{ type: 'result', result: 'free', total_cost_usd: 0 }]), [{ type: 'result', ok: true, text: 'free', costUsd: 0 }]);
});

test('codex and cursor report no cost', () => {
  assert.deepEqual(feed('codex', [{ type: 'turn.completed', usage: { input_tokens: 5 } }]), [{ type: 'result', ok: true, text: '' }]);
  assert.deepEqual(feed('cursor', [{ type: 'result', result: 'ok' }]), [{ type: 'result', ok: true, text: 'ok' }]);
});

test('opencode: the cost seen so far survives a later error, adds up per step and $0 stays known', () => {
  const stop = (cost?: number) => ({ type: 'step_finish', part: { reason: 'stop', ...(cost === undefined ? {} : { cost }) } });
  const error = { type: 'error', error: { name: 'APIError' } };
  assert.deepEqual(feed('opencode', [stop(0.25), error]).at(-1), { type: 'result', ok: false, text: 'APIError', costUsd: 0.25 });
  assert.equal((feed('opencode', [stop(0.25), stop(0.5)]).at(-1) as { costUsd?: number }).costUsd, 0.75);
  assert.deepEqual(feed('opencode', [stop(0)]), [{ type: 'result', ok: true, text: '', costUsd: 0 }]);
  assert.deepEqual(feed('opencode', [stop()]), [{ type: 'result', ok: true, text: '' }]);
});

test('opencode: events, resume and config', () => {
  const events = feed('opencode', [
    { type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start' } },
    { type: 'tool_use', sessionID: 'ses_1', part: { tool: 'bash', state: { status: 'completed', input: { command: 'ls' } } } },
    { type: 'tool_use', sessionID: 'ses_1', part: { tool: 'edit', state: { status: 'error', error: 'denied' } } },
    { type: 'text', sessionID: 'ses_1', part: { text: 'all done' } },
    { type: 'step_finish', sessionID: 'ses_1', part: { reason: 'tool-calls' } },
    { type: 'step_finish', sessionID: 'ses_1', part: { reason: 'stop', cost: 0.25 } },
  ]);
  assert.deepEqual(events, [
    { type: 'session', id: 'ses_1' },
    { type: 'tool', tool: 'shell', detail: 'ls' },
    { type: 'tool-error', text: 'denied' },
    { type: 'text', text: 'all done' },
    { type: 'result', ok: true, text: 'all done', costUsd: 0.25 },
  ]);
  assert.deepEqual(feed('opencode', [{ type: 'error', error: { name: 'APIError', data: { message: 'Unauthorized' } } }]), [{ type: 'result', ok: false, text: 'Unauthorized' }]);

  const p = getProvider('opencode');
  const args = p.buildArgs(ctx({ sessionId: 'ses_1', model: 'openai/gpt-5', permissionMode: 'bypassPermissions' }));
  assert.deepEqual(args.slice(0, 6), ['run', '--format', 'json', '--auto', '--model', 'openai/gpt-5']);
  assert.ok(args.includes('--session') && args.includes('ses_1'));
  const config = JSON.parse(p.env!(ctx()).OPENCODE_CONFIG_CONTENT!);
  assert.deepEqual(config.mcp.office.command, ['/bin/tsx', '/x/office-mcp.ts']);
  assert.equal(config.mcp.office.environment.AGENT_ID, 'a1');
});

test('opencode never gets an "ask" rule: looking around is allowed, other commands follow the allowed tools', () => {
  const p = getProvider('opencode');
  const config = (over: object) => JSON.parse(p.env!(ctx(over)).OPENCODE_CONFIG_CONTENT!).permission;
  const accept = config({ permissionMode: 'acceptEdits', allowedTools: 'WebSearch Bash(npm run:*) Bash(git status)' });
  assert.equal(accept.edit, 'allow');
  assert.equal(Object.keys(accept.bash)[0], '*', 'the catch-all comes first so specific rules win');
  assert.equal(accept.bash['*'], 'deny');
  assert.equal(accept.bash['ls *'], 'allow');
  assert.equal(accept.bash['npm run *'], 'allow');
  assert.equal(accept.bash['git status'], 'allow');
  assert.ok(!JSON.stringify(accept).includes('ask'));
  assert.equal(config({ permissionMode: 'plan' }).edit, 'deny');
  assert.equal(config({ permissionMode: 'bypassPermissions' }), undefined);
});

test('providers say which files a call writes', () => {
  const claude = feed('claude', [
    { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/w/docs/a.md' } },
      { type: 'tool_use', id: 'w2', name: 'Write', input: { file_path: '/w/root.md' } },
      { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/w/docs/b.md' } },
    ] } },
    { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'w1', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'w2', is_error: true, content: 'denied' },
      { type: 'tool_result', tool_use_id: 'r1', content: 'text' },
    ] } },
  ]);
  assert.deepEqual(claude.filter(e => e.type === 'files'), [{ type: 'files', files: ['/w/docs/a.md'] }], 'a denied write wrote nothing');
  const codex = feed('codex', [{ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'src/x.ts', kind: 'update' }] } }]);
  assert.deepEqual((codex[0] as any).files, ['src/x.ts']);
  const oc = feed('opencode', [{ type: 'tool_use', sessionID: 's', part: { tool: 'write', state: { status: 'completed', input: { filePath: '/w/index.html' } } } }]);
  assert.deepEqual((oc.at(-1) as any).files, ['/w/index.html']);
  const cursor = feed('cursor', [{ type: 'tool_call', subtype: 'started', tool_call: { editToolCall: { args: { path: 'a.ts' } } } }]);
  assert.deepEqual((cursor[0] as any).files, ['a.ts']);
});

test('role rules reach every CLI: opencode path-scoped writes, codex writable sandbox, claude approval tool', () => {
  const oc = getProvider('opencode');
  const perm = (over: object) => JSON.parse(oc.env!(ctx(over)).OPENCODE_CONFIG_CONTENT!).permission;
  const analyst = perm({ permissionMode: 'default', allowedTools: 'Edit(docs/**)' });
  assert.deepEqual(analyst.edit, { '*': 'deny', '*/docs/*': 'allow' });
  assert.equal(analyst.webfetch, 'deny');
  assert.equal(analyst.bash['git status'], undefined, 'no git for roles that were not given it');
  assert.equal(analyst.bash['*'], 'deny');
  const tester = perm({ permissionMode: 'default', allowedTools: 'Bash(npm test:*) Edit(**/*.test.*) Edit(tests/**) WebSearch' });
  assert.deepEqual(tester.edit, { '*': 'deny', '*.test.*': 'allow', '*/tests/*': 'allow' });
  assert.equal(tester.bash['npm test *'], 'allow');
  assert.equal(tester.webfetch, 'allow');
  assert.equal(perm({ permissionMode: 'default', allowedTools: '' }).edit, 'deny');

  const codexArgs = (over: object) => getProvider('codex').buildArgs(ctx(over));
  assert.ok(codexArgs({ permissionMode: 'default', allowedTools: 'Edit(docs/**)' }).includes('--full-auto'), 'a docs writer needs a writable sandbox');
  assert.ok(codexArgs({ permissionMode: 'default', allowedTools: '' }).includes('read-only'));

  const claudeArgs = getProvider('claude').buildArgs(ctx({ permissionMode: 'default', allowedTools: 'Edit(docs/**)' }));
  assert.ok(claudeArgs.includes('mcp__office__request_approval'));
  assert.ok(claudeArgs.includes('mcp__office__remember') && claudeArgs.includes('mcp__office__recall'));
  assert.ok(claudeArgs.includes('Edit(docs/**)'));
});

test('tool calls carry their whole input for the transcript, unless the summary already says it all', () => {
  const long = 'echo ' + 'x'.repeat(200);
  const inputOf = (provider: string, lines: object[]) => (feed(provider, lines).find(e => e.type === 'tool') as any)?.input;
  const claudeCall = (name: string, input: object) => [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: '1', name, input }] } }];
  assert.equal(inputOf('claude', claudeCall('Bash', { command: long, description: 'Say x' })), long);
  assert.equal(inputOf('claude', claudeCall('Bash', { command: 'ls' })), undefined);
  assert.equal(JSON.parse(inputOf('claude', claudeCall('Grep', { pattern: 'x', path: 'src' }))).path, 'src');
  assert.equal(inputOf('codex', [{ type: 'item.started', item: { type: 'command_execution', command: long } }]), long);
  assert.equal(inputOf('opencode', [{ type: 'tool_use', part: { tool: 'bash', state: { status: 'running', input: { command: long } } } }]), long);
  assert.equal(JSON.parse(inputOf('cursor', [{ type: 'tool_call', subtype: 'started', tool_call: { editToolCall: { args: { path: 'a.md', text: 'hello' } } } }])).text, 'hello');
});
