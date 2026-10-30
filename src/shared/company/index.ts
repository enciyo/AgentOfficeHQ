// The default company (teams, roles, prompts) in a given language, built from language-independent structure + text.
import { fill, type Locale } from '../i18n/index.ts';
import { enCompany } from './en.ts';
import type { CompanyText, MemberKey, StageKey } from './text.ts';
import { trCompany } from './tr.ts';

const TEXTS: Record<Locale, CompanyText> = { tr: trCompany, en: enCompany };

// Allowed tools in Claude's rule syntax; providers translate them (see infrastructure/providers).
// Reading and searching files needs no rule; everything not listed is refused.
const WEB = 'WebSearch WebFetch';
/** Writing only under docs/: requests, analyses, designs, reports. */
const DOCS = 'Edit(docs/**)';
/** Developers: package managers, running the code, read-only git. */
const DEV_TOOLS = 'Bash(npm:*) Bash(npx:*) Bash(node:*) Bash(pnpm:*) Bash(yarn:*) Bash(python3:*) Bash(pip:*) Bash(git status) Bash(git diff:*) Bash(git log:*) Bash(ls:*) Bash(mkdir:*)';
/** Running the test suites and nothing else. */
const TEST_RUN = 'Bash(npm test:*) Bash(npm run test:*) Bash(npx vitest:*) Bash(npx jest:*) Bash(npx playwright test:*) Bash(node --test:*) Bash(pytest:*) Bash(python3 -m pytest:*) Bash(ls:*)';
/** Writing test files only. */
const TEST_FILES = 'Edit(**/*.test.*) Edit(**/*.spec.*) Edit(tests/**) Edit(test/**) Edit(e2e/**)';
const tools = (...parts: string[]) => parts.join(' ');

/**
 * Language-independent: color, allowed tools and permission mode of every member. Only developers edit freely
 * (acceptEdits); everyone else runs in `default` mode, where the tools above are all they may use.
 */
const LOOK: Record<MemberKey, { color: string; tools: string; mode: 'default' | 'acceptEdits' }> = {
  pm: { color: '#f59e0b', tools: DOCS, mode: 'default' },
  researcher: { color: '#fbbf24', tools: tools(WEB, DOCS), mode: 'default' }, marketing: { color: '#f97316', tools: tools(WEB, DOCS), mode: 'default' },
  growth: { color: '#84cc16', tools: tools(WEB, DOCS), mode: 'default' }, sales: { color: '#eab308', tools: tools(WEB, DOCS), mode: 'default' },
  leadAnalyst: { color: '#a855f7', tools: DOCS, mode: 'default' }, techAnalyst: { color: '#c084fc', tools: DOCS, mode: 'default' },
  ux: { color: '#14b8a6', tools: DOCS, mode: 'default' }, ui: { color: '#2dd4bf', tools: DOCS, mode: 'default' },
  techLead: { color: '#3b82f6', tools: DEV_TOOLS, mode: 'acceptEdits' }, frontend: { color: '#38bdf8', tools: DEV_TOOLS, mode: 'acceptEdits' }, backend: { color: '#6366f1', tools: DEV_TOOLS, mode: 'acceptEdits' },
  testLead: { color: '#ef4444', tools: tools(TEST_RUN, DOCS), mode: 'default' }, automation: { color: '#f87171', tools: tools(TEST_RUN, TEST_FILES, DOCS), mode: 'default' },
};

const PRODUCT_MEMBERS = ['researcher', 'marketing', 'growth', 'sales'] as const;
// Workflow order; the lead comes first and the rest of the team follows
const STAGES: { key: StageKey; lead: MemberKey; members: MemberKey[] }[] = [
  { key: 'analysis', lead: 'leadAnalyst', members: ['techAnalyst'] },
  { key: 'design', lead: 'ux', members: ['ui'] },
  { key: 'development', lead: 'techLead', members: ['frontend', 'backend'] },
  { key: 'test', lead: 'testLead', members: ['automation'] },
];

export function buildCompany(locale: Locale) {
  const text = TEXTS[locale];
  const m = (key: MemberKey) => text.members[key];
  const slug = (name: string) => name.toLocaleLowerCase(text.slugLocale).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  const rules = { assume: text.rules.assume, report: text.rules.report };

  const member = (key: MemberKey, team: string, prompt: string) =>
    ({ name: m(key).name, role: m(key).role, color: LOOK[key].color, allowedTools: LOOK[key].tools, permissionMode: LOOK[key].mode, prompt, team });

  const stagePrompt = (stage: (typeof STAGES)[number], key: MemberKey) => {
    const s = text.stages[stage.key];
    const lead = m(stage.lead);
    if (key === stage.lead) {
      const people = [stage.lead, ...stage.members].map(k => fill(k === stage.lead ? text.lines.self : text.lines.peer, { name: m(k).name }) + `: ${m(k).focus}`);
      return fill(text.templates.stageLead, {
        ...rules, team: s.team, leadRole: lead.role, stage: s.stage, people: people.join('\n'), reads: s.reads.join(', '),
        dir: s.dir, leadSlug: slug(lead.name), file: s.file, merge: s.merge, leadNote: s.leadNote ? `\n${s.leadNote}\n` : '', limits: m(key).limits,
      });
    }
    return fill(text.templates.stageMember, {
      ...rules, team: s.team, role: m(key).role, lead: lead.name, focus: m(key).focus, dir: s.dir, slug: slug(m(key).name), memberNote: s.memberNote ? `- ${s.memberNote}\n` : '', limits: m(key).limits,
    });
  };

  const pm = fill(text.templates.pm, {
    productMembers: PRODUCT_MEMBERS.map(k => fill(text.lines.productMember, { name: m(k).name, focus: m(k).focus })).join('\n'),
    stageTeams: STAGES.map(st => fill(text.lines.stageTeam, { team: text.stages[st.key].team, lead: m(st.lead).name, members: st.members.map(k => m(k).name).join(', ') })).join('\n'),
    analysisLead: m('leadAnalyst').name, designLead: m('ux').name, devLead: m('techLead').name, testLead: m('testLead').name,
    marketing: m('marketing').name, sales: m('sales').name, limits: m('pm').limits,
  });

  const defaultTeam = [
    member('pm', text.productTeam, pm),
    ...PRODUCT_MEMBERS.map(k => member(k, text.productTeam, fill(text.templates.productMember, { ...rules, role: m(k).role, focus: m(k).focus, slug: slug(m(k).name), limits: m(k).limits }))),
    ...STAGES.flatMap(st => [st.lead, ...st.members].map(k => member(k, text.stages[st.key].team, stagePrompt(st, k)))),
  ];

  return {
    text,
    defaultTeam,
    /** Team list: leader first (sits at the head of the team table in the layout). */
    teams: [
      { team: text.productTeam, lead: m('pm').name, members: PRODUCT_MEMBERS.map(k => m(k).name) },
      ...STAGES.map(st => ({ team: text.stages[st.key].team, lead: m(st.lead).name, members: st.members.map(k => m(k).name) })),
    ],
    /** Role templates in the hiring form. */
    presets: defaultTeam.map(({ name, role, color, prompt, allowedTools, permissionMode }) => ({ id: name, role, color, prompt, allowedTools, permissionMode })),
  };
}
