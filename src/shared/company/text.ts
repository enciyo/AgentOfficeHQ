// Shape of the per-language text of the default company (names, roles, prompts).
interface MemberText { name: string; role: string; focus: string; /** What the member does not do: where they may not write, which commands they may not run. */ limits: string }

interface StageText {
  team: string; stage: string; file: string; dir: string; reads: string[]; merge: string;
  leadNote?: string; memberNote?: string;
}

type ProductKey = 'researcher' | 'marketing' | 'growth' | 'sales';
export type StageKey = 'analysis' | 'design' | 'development' | 'test';
export type MemberKey = 'pm' | ProductKey | 'leadAnalyst' | 'techAnalyst' | 'ux' | 'ui' | 'techLead' | 'frontend' | 'backend' | 'testLead' | 'automation';

/** Placeholders are `{name}`; see company/index.ts for what each template receives. */
export interface CompanyText {
  /** Locale used to build file-name slugs from names. */
  slugLocale: string;
  productTeam: string;
  members: Record<MemberKey, MemberText>;
  stages: Record<StageKey, StageText>;
  rules: { report: string; assume: string };
  lines: { self: string; peer: string; productMember: string; stageTeam: string };
  templates: { productMember: string; stageLead: string; stageMember: string; pm: string };
  /** Words the prompts rely on; tests check that every prompt uses them consistently. */
  markers: { flow: string; noDelegate: string; pass: string; fail: string; fixes: string; waiting: string };
}
