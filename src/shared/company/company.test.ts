// Default company structure tests (every language): `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES } from '../i18n/index.ts';
import { buildCompany } from './index.ts';

for (const locale of LOCALES) {
  const { text, defaultTeam, teams, presets } = buildCompany(locale);
  const { markers } = text;
  const byName = new Map(defaultTeam.map(a => [a.name, a]));
  const quoted = (s: string) => [...s.matchAll(/"([^"]+)"/g)].map(m => m[1]!).filter(n => ![markers.pass, markers.fail, markers.fixes].includes(n) && !n.startsWith(markers.waiting));

  test(`${locale}: teams and minimum headcounts`, () => {
    const size = teams.map(t => 1 + t.members.length);
    assert.equal(teams.length, 5);
    assert.deepEqual(teams.map(t => t.team), [text.productTeam, ...Object.values(text.stages).map(s => s.team)]);
    assert.ok(size[0]! >= 5 && size[1]! >= 2 && size[2]! >= 2 && size[3]! >= 3 && size[4]! >= 2);
    assert.equal(teams[0]!.lead, 'Product Manager');
    assert.deepEqual(teams[0]!.members, [text.members.researcher.name, text.members.marketing.name, text.members.growth.name, text.members.sales.name]);
  });

  test(`${locale}: everyone is defined, names are unique, team is correct`, () => {
    assert.equal(byName.size, defaultTeam.length);
    for (const t of teams) for (const n of [t.lead, ...t.members]) {
      const a = byName.get(n);
      assert.ok(a, `${n} is not in the team`);
      assert.equal(a.team, t.team);
      assert.ok(a.role && a.color && a.prompt.length > 300, `${n} is incompletely defined`);
    }
  });

  test(`${locale}: no unfilled placeholders`, () => {
    for (const a of defaultTeam) assert.ok(!/\{\w+\}/.test(a.prompt), `${a.name} has an unfilled placeholder`);
  });

  test(`${locale}: everyone named in the prompts exists (handoff is by name)`, () => {
    for (const a of defaultTeam) for (const n of quoted(a.prompt)) assert.ok(byName.has(n), `"${n}" in ${a.name}'s prompt is not in the team`);
  });

  test(`${locale}: PM hands stages to leads in order`, () => {
    const pm = byName.get('Product Manager')!.prompt;
    const flow = pm.slice(pm.indexOf(markers.flow));
    const idx = teams.slice(1).map(t => flow.indexOf(`"${t.lead}"`));
    assert.ok(idx.every(i => i > 0), 'every lead must appear in the flow');
    assert.deepEqual([...idx].sort((a, b) => a - b), idx);
    for (const n of teams[0]!.members) assert.ok(pm.includes(`"${n}"`), `PM must know member ${n}`);
  });

  test(`${locale}: leads know their team, members know their lead and do not delegate`, () => {
    for (const t of teams.slice(1)) {
      const lead = byName.get(t.lead)!.prompt;
      assert.ok(lead.includes('delegate_task'));
      for (const m of t.members) {
        assert.ok(lead.includes(`"${m}"`), `${t.lead} must know member ${m}`);
        const p = byName.get(m)!.prompt;
        assert.ok(p.includes(`"${t.lead}"`), `${m} must know their lead`);
        assert.ok(p.includes(markers.noDelegate), `${m} must not delegate`);
      }
    }
    for (const m of teams[0]!.members) assert.ok(byName.get(m)!.prompt.includes(markers.noDelegate));
  });

  test(`${locale}: stage document chain`, () => {
    const { members: m, stages: s } = text;
    const chain: [string, string, string][] = [
      [m.leadAnalyst.name, s.analysis.file, s.analysis.reads[0]!], [m.ux.name, s.design.file, s.design.reads[1]!],
      [m.techLead.name, s.development.file, s.development.reads[2]!], [m.testLead.name, s.test.file, s.test.reads[2]!],
    ];
    for (const [lead, out, input] of chain) {
      const p = byName.get(lead)!.prompt;
      assert.ok(p.includes(out), `${lead} must write ${out}`);
      assert.ok(p.includes(input), `${lead} must read ${input}`);
    }
    const testLead = byName.get(m.testLead.name)!.prompt;
    assert.ok(testLead.includes(markers.pass) && testLead.includes(markers.fail));
  });

  test(`${locale}: every role does only its own job (limits, tools, permission mode)`, () => {
    const devs = new Set([text.members.techLead.name, text.members.frontend.name, text.members.backend.name]);
    const testers = new Set([text.members.testLead.name, text.members.automation.name]);
    for (const a of defaultTeam) {
      const limits = Object.values(text.members).find(m => m.name === a.name)!.limits;
      assert.ok(limits.length > 40 && a.prompt.includes(limits), `${a.name} must be told its limits`);
      const bash = [...a.allowedTools.matchAll(/Bash\(([^)]+)\)/g)].map(m => m[1]!);
      if (devs.has(a.name)) {
        assert.equal(a.permissionMode, 'acceptEdits');
        continue;
      }
      assert.equal(a.permissionMode, 'default', `${a.name} may only use its own tools`);
      assert.ok(!bash.some(c => c.startsWith('git')), `${a.name} must not use git`);
      if (!testers.has(a.name)) assert.deepEqual(bash, [], `${a.name} must not run commands`);
      else assert.ok(bash.every(c => /test|pytest|vitest|jest|playwright|^ls/.test(c)), `${a.name} only runs tests`);
      const writes = [...a.allowedTools.matchAll(/Edit\(([^)]+)\)/g)].map(m => m[1]!);
      assert.ok(writes.includes('docs/**'), `${a.name} writes its documents under docs/`);
      if (a.name !== text.members.automation.name) assert.deepEqual(writes, ['docs/**'], `${a.name} writes nowhere else`);
    }
  });

  test(`${locale}: role presets are unique`, () => {
    assert.equal(new Set(presets.map(p => p.id)).size, presets.length);
  });
}
