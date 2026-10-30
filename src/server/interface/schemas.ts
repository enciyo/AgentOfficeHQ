// Request body schemas (zod). Unknown keys are dropped, so handlers only see allowed fields.
// Validation messages are translation keys; the HTTP layer translates them.
import { z } from 'zod';
import { LOCALES } from '../../shared/i18n/index.ts';
import { TEAM_FILE_FORMAT, TEAM_FILE_VERSION } from '../../shared/types.ts';
import { MAX_TIMER_MIN } from '../domain/limits.ts';

const text = z.string();

const agentFields = {
  name: z.string().trim().min(1, 'err.nameRequired'),
  role: text, kind: z.enum(['agent', 'human']), provider: text, color: text, prompt: text, model: text,
  cwd: text, permissionMode: text, allowedTools: text, team: z.string().trim(),
};

export const hireAgent = z.object(agentFields).partial().required({ name: true });
export const updateAgent = z.object(agentFields).partial();
export const assignTask = z.object({ prompt: z.string().trim().min(1, 'err.taskEmpty') });
export const editTask = assignTask;
export const pauseOffice = z.object({ paused: z.boolean() });
export const completeTask = z.object({ result: text.default('') });
export const delegateTask = z.object({ from: text.default(''), to: text, task: text, parentTaskId: text.optional() });
export const updateOffice = z.object({ name: text, floorColor: text, wallColor: text }).partial();
export const updateSettings = z.object({ language: z.enum(LOCALES), binaries: z.record(z.string(), text), defaultProvider: text, defaultModels: z.record(z.string(), text), modelOverrides: z.record(z.string(), text), defaultCwd: text, worktrees: z.boolean(), approveMerges: z.boolean(), limits: z.lazy(() => limits), resumeInterrupted: z.boolean(), approvalPolicy: text, officeNotes: text, github: z.boolean(), playerName: text, playerColor: text }).partial();
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'err.invalid');
export const createSchedule = z.object({ agentId: text, prompt: z.string().trim().min(1, 'err.taskEmpty'), intervalMinutes: z.number().int(), at: clock.optional() });
export const updateSchedule = z.object({ prompt: z.string().trim().min(1, 'err.taskEmpty'), intervalMinutes: z.number().int(), at: clock, enabled: z.boolean() }).partial();
export const requestApproval = z.object({ agentId: text, taskId: text.optional(), action: text, details: text.default('') });
export const decideApproval = z.object({ approve: z.boolean(), note: text.default('') });
export const rememberNote = z.object({ agentId: text, taskId: text.optional(), text });
export const updateNote = z.object({ text, pinned: z.boolean() }).partial();
const money = z.number().min(0);
const timer = money.max(MAX_TIMER_MIN, 'err.timerTooLong');
export const limits = z.object({ taskTimeoutMin: timer, silenceTimeoutMin: timer, maxConcurrent: z.number().int().min(0), dailyBudgetUsd: money, agentDailyBudgetUsd: money, dailyRunMinutes: money, chainMaxTurns: z.number().int().min(0), chainBudgetUsd: money });
export const handoffTask = z.object({ agentId: text });
export const reactTask = z.object({ emoji: text });
export const acceptVisitor = z.object({ agentId: text });
export const installTeam = z.object({ replace: z.boolean().default(false) });
const { name, role, kind, provider, color, prompt, model, permissionMode, allowedTools, team } = agentFields;
const teamMember = z.object({ name, role, kind, provider, color, prompt, model, permissionMode, allowedTools, team }).partial().required({ name: true });
export const importTeam = z.object({
  format: z.string().refine(v => v === TEAM_FILE_FORMAT, 'err.teamFile'),
  version: z.number().refine(v => v === TEAM_FILE_VERSION, 'err.teamFile'),
  agents: z.array(teamMember).min(1, 'err.teamFile').max(200, 'err.teamFile'),
  replace: z.boolean().default(false),
});
