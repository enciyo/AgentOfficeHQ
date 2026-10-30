// Pure view derivations: delegation trees, spend breakdown, file tree: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createT } from '../../shared/i18n/index.ts';
import type { Approval, ProviderHold, ProviderInfo, PublicAgent, Task } from '../../shared/types.ts';
import { MAX_DROP_BYTES, mergeBadge, patchLines, resolvable, chainActive, chainHoldLabel, cliStatus, holdLabel, chainFiles, reportWait, retryable, waitLabel, fileOwners, filterTrees, chatItems, costBreakdown, costUnknown, dropProblem, dropPrompt, fileTree, spentToday, standupLines, taskCostText, taskTrees, treeCostText } from './views.ts';

const t = createT('en');
let n = 0;
const task = (over: Partial<Task>): Task => ({
  id: `t${++n}`, agentId: 'a', prompt: '', from: 'user', parentId: null, depth: 0, kind: 'task', status: 'done',
  createdAt: n, startedAt: n, endedAt: n + 10, result: '', cost: 0, ...over,
});
const person = (id: string, team: string): PublicAgent => ({
  id, name: id.toUpperCase(), kind: 'agent', provider: 'claude', role: '', color: '#000', prompt: '', model: '', cwd: '', permissionMode: '',
  allowedTools: '', team, sessionId: null, totalCost: 0, hiredAt: 0, status: 'idle', activity: '', currentTaskId: null, queued: 0,
});

test('taskTrees nests the chain and sums cost; open anywhere keeps the root open', () => {
  const root = task({ id: 'r', cost: 1, createdAt: 1 });
  const child = task({ id: 'c', parentId: 'r', cost: 2, createdAt: 2 });
  const grand = task({ id: 'g', parentId: 'c', cost: 0.5, status: 'running', endedAt: null, createdAt: 3 });
  const orphan = task({ id: 'o', parentId: 'gone', createdAt: 4 });
  const trees = taskTrees([grand, child, root, orphan]);
  assert.deepEqual(trees.map(x => x.task.id), ['o', 'r'], 'roots newest first; a missing parent makes a root');
  const r = trees[1]!;
  assert.equal(r.cost, 3.5);
  assert.equal(r.children[0]!.children[0]!.task.id, 'g');
  assert.equal(r.open, true);
  assert.equal(r.end, null);
  grand.status = 'done'; grand.endedAt = 50;
  assert.equal(taskTrees([grand, child, root])[0]!.end, 50);
});

test('costBreakdown groups spend by team and agent', () => {
  const agents = [person('a', 'Dev'), person('b', 'Dev'), person('c', '')];
  const tasks = [task({ agentId: 'a', cost: 1 }), task({ agentId: 'b', cost: 2 }), task({ agentId: 'c', cost: 0.5 }), task({ agentId: 'c', cost: 0 })];
  const { total, teams, agents: rows } = costBreakdown(agents, tasks, t);
  assert.equal(total, 3.5);
  assert.deepEqual(teams.map(r => [r.label, r.cost, r.tasks]), [['Dev', 3, 2], [t('side.noTeam'), 0.5, 1]]);
  assert.deepEqual(rows.map(r => r.label), ['B', 'A', 'C']);
});

test('fileTree builds folders first with aggregated size', () => {
  const tree = fileTree([
    { path: 'README.md', size: 1, mtime: 1 },
    { path: 'docs/r1/plan.md', size: 3, mtime: 5 },
    { path: 'docs/r1/spec.md', size: 4, mtime: 2 },
  ]);
  assert.deepEqual(tree.map(n => n.name), ['docs', 'README.md']);
  assert.equal(tree[0]!.size, 7);
  assert.equal(tree[0]!.mtime, 5);
  assert.deepEqual(tree[0]!.children[0]!.children.map(n => n.path), ['docs/r1/plan.md', 'docs/r1/spec.md']);
});

test('chatItems offers a retry only for failed tasks the CEO gave', () => {
  const pm = person('pm', '');
  const items = chatItems(pm, [
    task({ agentId: 'pm', prompt: 'do it', status: 'error', result: 'boom' }),
    task({ agentId: 'pm', from: 'x', kind: 'report', status: 'error', result: 'bad' }),
  ], id => id, t);
  assert.deepEqual(items.filter(i => i.retry).map(i => i.retry), ['do it']);
});

test('stand-up lines come from the current state: working, queued, recently done, idle', () => {
  const now = 1_000_000_000;
  const busy = { ...person('a', ''), status: 'working' as const, currentTaskId: 'w' };
  const waiting = { ...person('b', ''), queued: 2 };
  const doneRecently = person('c', '');
  const free = person('d', '');
  const tasks = [
    task({ id: 'w', agentId: 'a', prompt: 'Build   the\nlogin page', status: 'running', endedAt: null }),
    task({ agentId: 'c', prompt: 'Write tests', endedAt: now - 3_600_000 }),
    task({ agentId: 'd', prompt: 'Old work', endedAt: now - 3 * 86_400_000 }),
  ];
  const lines = standupLines([busy, waiting, doneRecently, free], tasks, t, now);
  assert.deepEqual(lines.map(l => l.text), [
    t('standup.working', { what: 'Build the login page' }),
    t('standup.queued', { n: 2 }),
    t('standup.done', { what: 'Write tests' }),
    t('standup.idle'),
  ]);
});

test('dropped files must be small text files and travel inside the prompt unchanged', () => {
  assert.equal(dropProblem(10, 'hello'), null);
  assert.equal(dropProblem(MAX_DROP_BYTES + 1, 'x'), 'drop.tooBig');
  assert.equal(dropProblem(10, 'a\u0000b'), 'drop.binary');
  const prompt = dropPrompt('app.ts', 'const a = "```";', t);
  assert.ok(prompt.includes('`app.ts`'));
  assert.ok(prompt.includes('const a = "```";'));
});

test('chat replies carry their task id and reactions', () => {
  const pm = person('pm', '');
  const items = chatItems(pm, [task({ id: 'x', agentId: 'pm', prompt: 'hi', result: 'hello', reactions: ['🎉'] })], id => id, t);
  const reply = items.find(i => i.kind === 'pm')!;
  assert.equal(reply.taskId, 'x');
  assert.deepEqual(reply.reactions, ['🎉']);
});

test('a chain lists every file written under it; each file knows its last writer', () => {
  const root = task({ id: 'r', files: ['docs/plan.md'], createdAt: 1, endedAt: 50 });
  const kid = task({ id: 'k', parentId: 'r', files: ['site/index.html', 'docs/plan.md'], createdAt: 2, endedAt: 40 });
  const other = task({ id: 'o', files: ['site/index.html'], createdAt: 3, endedAt: 60 });
  assert.deepEqual(chainFiles([root, kid, other], 'r'), ['docs/plan.md', 'site/index.html']);
  assert.deepEqual(chainFiles([root, kid, other], 'k'), ['site/index.html', 'docs/plan.md']);
  assert.deepEqual(chainFiles([], 'gone'), []);
  const owners = fileOwners([root, kid, other]);
  assert.equal(owners.get('site/index.html')!.id, 'o');
  assert.equal(owners.get('docs/plan.md')!.id, 'r');
});

test('flow filters by status and searches prompts, agents and files through the chain', () => {
  const done = task({ id: 'd', prompt: 'Morning brief', createdAt: 1 });
  const deep = task({ id: 'x', parentId: 'd', prompt: 'layout', files: ['site/brief.html'], createdAt: 2 });
  const broken = task({ id: 'b', prompt: 'Pricing page', createdAt: 3 });
  const brokenKid = task({ id: 'bk', parentId: 'b', status: 'error', createdAt: 4 });
  const live = task({ id: 'l', prompt: 'Logo', status: 'running', endedAt: null, createdAt: 5 });
  const trees = taskTrees([done, deep, broken, brokenKid, live]);
  const ids = (f: Parameters<typeof filterTrees>[1], q = '') => filterTrees(trees, f, q, id => (id === 'a' ? 'Ada' : '')).map(n => n.task.id);
  assert.deepEqual(ids('all'), ['l', 'b', 'd']);
  assert.deepEqual(ids('active'), ['l']);
  assert.deepEqual(ids('failed'), ['b'], 'a failure anywhere in the chain counts');
  assert.deepEqual(ids('done'), ['d']);
  assert.deepEqual(ids('all', 'brief.html'), ['d'], 'files written deep in the chain are searched');
  assert.deepEqual(ids('all', 'ada'), ['l', 'b', 'd'], 'agent names are searched');
});

const approval = (taskId: string, status: Approval['status'] = 'pending'): Approval =>
  ({ id: `a${++n}`, agentId: 'a', taskId, action: '', details: '', status, note: '', createdAt: 0, decidedAt: null });

test('reportWait counts a report held below: that one has to go first', () => {
  const top = { id: 'top', parentId: null, status: 'done', awaiting: true } as Task;
  const below = { id: 'below', parentId: 'top', status: 'error', awaiting: true } as Task;
  assert.deepEqual(reportWait([top, below], [], top), { subtasks: 1, approvals: 0 });
  assert.deepEqual(reportWait([top, below], [], below), { subtasks: 0, approvals: 0 });
});

test('reportWait counts the open work and undecided approvals under a held report', () => {
  const held = task({ id: 'h', awaiting: true });
  const open = task({ id: 'o', parentId: 'h', status: 'running', endedAt: null });
  const deep = task({ id: 'd', parentId: 'o', status: 'queued', endedAt: null });
  const closed = task({ id: 'c', parentId: 'h' });
  const other = task({ id: 'x', status: 'queued', endedAt: null });
  const all = [held, open, deep, closed, other];
  assert.deepEqual(reportWait(all, [approval('c'), approval('h', 'approved'), approval('x')], held), { subtasks: 2, approvals: 1 });
  assert.equal(reportWait(all, [], open), null, 'not held');
});

test('waitLabel says what is missing, and says so when nothing will ever finish it', () => {
  assert.equal(waitLabel({ subtasks: 2, approvals: 1 }, t), t('task.waiting', { what: `${t('task.waitSubtasks', { n: 2 })}, ${t('task.waitApproval', { n: 1 })}` }));
  assert.equal(waitLabel({ subtasks: 1, approvals: 0 }, t), t('task.waiting', { what: t('task.waitSubtask', { n: 1 }) }));
  assert.equal(waitLabel({ subtasks: 0, approvals: 3 }, t), t('task.waiting', { what: t('task.waitApprovals', { n: 3 }) }));
  assert.equal(waitLabel({ subtasks: 0, approvals: 0 }, t), t('task.stuck'));
});

test('chainActive: open work or a held report anywhere keeps a chain cancellable', () => {
  const root = task({ id: 'cr' });
  const held = task({ id: 'ch', parentId: 'cr', awaiting: true });
  assert.equal(chainActive(taskTrees([root, held])[0]!), true);
  held.awaiting = false;
  assert.equal(chainActive(taskTrees([root, held])[0]!), false);
  held.status = 'queued';
  assert.equal(chainActive(taskTrees([root, held])[0]!), true);
});

test('cliStatus says what the health check found', () => {
  const cli = (over: Partial<ProviderInfo>) => ({ id: 'codex', label: 'Codex CLI', models: [], delegation: true, available: false, path: null, health: 'missing', ...over }) as ProviderInfo;
  assert.match(cliStatus(cli({}), t), /Codex CLI not found.*CODEX_BIN/);
  assert.match(cliStatus(cli({ path: '/bin/codex', health: 'broken', healthError: 'dyld failed' }), t), /\/bin\/codex.*dyld failed/);
  assert.match(cliStatus(cli({ path: '/bin/codex', health: 'ok', available: true, version: '1.2.3' }), t), /\/bin\/codex.*1\.2\.3/);
  assert.match(cliStatus(cli({ path: '/bin/codex', health: 'ok', available: true }), t), /\/bin\/codex/);
});

test('holdLabel gives the limit its time and the login its way out', () => {
  const hold = (over: Partial<ProviderHold>): ProviderHold => ({ kind: 'limit', since: 0, until: new Date(2026, 10, 4, 19, 30).getTime(), message: 'session limit', ...over });
  assert.match(holdLabel(hold({}), 'en', t), /7:30.*session limit/);
  assert.match(holdLabel(hold({ kind: 'auth', until: null, message: 'Unauthorized' }), 'en', t), /Log in.*Unauthorized/);
});

test('a closed run without a reported cost reads as unknown, a real $0 as $0, and work that never ran as nothing', () => {
  assert.equal(taskCostText(task({ cost: null }), t), t('cost.unknown'));
  assert.equal(taskCostText(task({ cost: 0 }), t), '$0.000');
  assert.equal(taskCostText(task({ cost: 0.5 }), t, 2), '$0.50');
  assert.equal(taskCostText(task({ cost: 0, startedAt: null }), t), '', 'cancelled in the queue');
  assert.equal(taskCostText(task({ cost: null, status: 'running', endedAt: null }), t), '', 'may still report one');
  assert.equal(taskCostText(task({ cost: 0.5, status: 'running', endedAt: null }), t), '$0.500');
  assert.equal(costUnknown(task({ cost: null, status: 'queued' })), false);
});

test('a chain with an unknown cost in it does not pretend its sum is the whole cost', () => {
  const tree = (...costs: (number | null)[]) => {
    const root = task({ cost: costs[0]! });
    return taskTrees([root, ...costs.slice(1).map(cost => task({ parentId: root.id, cost }))])[0]!;
  };
  assert.equal(tree(1, 0.5).cost, 1.5);
  assert.equal(treeCostText(tree(1, 0.5), t), '$1.50');
  assert.equal(treeCostText(tree(1, null), t), t('cost.partial', { cost: '1.00' }));
  assert.equal(treeCostText(tree(null, null), t), t('cost.unknown'));
  assert.equal(treeCostText(tree(0), t), '');
});

test('the spend view counts the tasks whose cost nobody knows', () => {
  const spend = costBreakdown([person('a', 'Dev')], [task({ cost: 1 }), task({ cost: null }), task({ cost: null, status: 'running', endedAt: null })], t);
  assert.equal(spend.total, 1);
  assert.equal(spend.unknown, 1);
});

test('today\'s spend includes what a running task has reported, like the server\'s cap', () => {
  const now = new Date(2026, 10, 2, 15).getTime();
  assert.equal(spentToday([task({ cost: 1, endedAt: null, status: 'running' }), task({ cost: 2, endedAt: now - 1 }), task({ cost: null, endedAt: now - 1 }), task({ cost: 4, endedAt: 1 })], now), 3);
});

test('retryable: a failed task, unless a retry of it is open or done; a cancelled one does not count', () => {
  const failed = task({ id: 'f', status: 'error' });
  assert.equal(retryable(failed, [failed]), true);
  assert.equal(retryable(task({ status: 'done' }), []), false);
  assert.equal(retryable(task({ status: 'cancelled' }), []), false);
  assert.equal(retryable(failed, [failed, task({ retryOf: 'f', status: 'queued' })]), false);
  assert.equal(retryable(failed, [failed, task({ retryOf: 'f', status: 'error' })]), false);
  assert.equal(retryable(failed, [failed, task({ retryOf: 'f', status: 'cancelled' })]), true);
});

test('chainHoldLabel says which limit stopped the chain', () => {
  assert.match(chainHoldLabel({ kind: 'chainTurns', spent: 40, cap: 40 }, t), /40 \/ 40/);
  assert.match(chainHoldLabel({ kind: 'chainBudget', spent: 2.5, cap: 2 }, t), /\$2\.50 \/ \$2\.00/);
});

test('a merge conflict can go to the agent unless a resolver of it is open', () => {
  const conflict = task({ id: 'c', merge: 'conflict' });
  assert.equal(resolvable(conflict, [conflict]), true);
  assert.equal(resolvable(conflict, [conflict, task({ resolves: 'c', status: 'running', endedAt: null })]), false);
  assert.equal(resolvable(conflict, [conflict, task({ resolves: 'c', status: 'error' })]), true);
  assert.equal(resolvable(task({ merge: 'merged' }), []), false);
  assert.equal(resolvable(task({}), []), false);
});

test('the merge badge shows outcomes and stays away from work with nothing to merge', () => {
  assert.deepEqual(mergeBadge(task({ merge: 'conflict' })), { label: 'merge.conflict', tone: 'error' });
  assert.deepEqual(mergeBadge(task({ merge: 'rejected' })), { label: 'merge.rejected', tone: 'error' });
  assert.deepEqual(mergeBadge(task({ merge: 'pending' })), { label: 'merge.pending', tone: 'queued' });
  assert.deepEqual(mergeBadge(task({ merge: 'merged' })), { label: 'merge.merged', tone: 'done' });
  assert.equal(mergeBadge(task({ merge: 'unchanged' })), null);
  assert.equal(mergeBadge(task({})), null);
});

test('patch lines tell headers from changes, even a changed line that looks like a header', () => {
  const patch = ['diff --git a/x b/x', 'index 1..2 100644', '--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', ' same', '--- removed', '+++ added', 'diff --git a/y b/y', '--- a/y'].join('\n');
  assert.deepEqual(patchLines(patch).map(l => l.kind), ['file', 'file', 'file', 'file', 'hunk', 'context', 'del', 'add', 'file', 'file']);
  assert.deepEqual(patchLines(''), []);
});
