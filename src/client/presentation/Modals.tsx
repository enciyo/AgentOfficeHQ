import { useRef, useState, type FormEvent } from 'react';
import { LOCALES, type Locale } from '../../shared/i18n/index.ts';
import { MAX_OFFICE_NOTES_CHARS } from '../../shared/knowledge.ts';
import { newDraft, type AgentDraft } from '../domain/agentForm.ts';
import { MAX_QUALITY } from '../domain/quality.ts';
import { readTeamFile } from '../domain/teamFile.ts';
import { cliStatus, holdLabel } from '../domain/views.ts';
import { AgentForm } from './AgentForm.tsx';
import { RichText } from './common.tsx';
import { PriorityModal, VisitorModal } from './Fun.tsx';
import type { Theme } from '../application/officeStore.ts';
import { useActions, useOffice, useT } from './store.tsx';

const THEMES: Theme[] = ['system', 'light', 'dark'];
const SECTIONS = ['general', 'cli', 'work', 'limits', 'rules', 'team'] as const;
type Section = typeof SECTIONS[number];

// Language names are shown in their own language
const LANGUAGE_NAMES: Record<Locale, string> = { tr: 'Türkçe', en: 'English' };

export function ModalHost() {
  const modal = useOffice(s => s.modal);
  const { closeModal } = useActions();
  return (
    <div id="modal" className={`overlay ${modal ? '' : 'hidden'} ${modal === 'settings' || modal === 'hire' ? 'page' : ''}`} onPointerDown={e => e.target === e.currentTarget && closeModal()}>
      <div className="modal" id="modal-body" role="dialog" aria-modal="true">
        {modal === 'hire' && <HireForm />}
        {modal === 'settings' && <SettingsForm />}
        {modal === 'priority' && <PriorityModal />}
        {modal === 'visitor' && <VisitorModal />}
      </div>
    </div>
  );
}

function HireForm() {
  const { hire, closeModal } = useActions();
  const t = useT();
  const agents = useOffice(s => s.agents);
  const [draft, setDraft] = useState<AgentDraft>(() => newDraft(Object.values(agents)));
  const submit = (e: FormEvent) => { e.preventDefault(); hire(draft); };
  return (
    <>
      <h2>{t('hire.title')}</h2>
      <form onSubmit={submit}>
        <AgentForm draft={draft} onChange={setDraft} isNew />
        <div className="row end"><button type="button" onClick={closeModal}>{t('ui.cancel')}</button><button className="primary" type="submit">{t('hire.submit')}</button></div>
      </form>
    </>
  );
}

function SettingsForm() {
  const { saveSettings, installDefaultTeam, deleteTeam, importTeam, badTeamFile, setTheme, setGraphics, refreshDefaultRoles, closeModal, setAlerts, alertsState, refreshVisitors, resumeProvider } = useActions();
  const alerts = alertsState();
  const t = useT();
  const office = useOffice(s => s.office);
  const theme = useOffice(s => s.theme);
  const graphics = useOffice(s => s.graphics);
  const settings = useOffice(s => s.settings);
  const providers = useOffice(s => s.providers);
  const holds = useOffice(s => s.providerHolds);
  const agentCount = useOffice(s => Object.keys(s.agents).length);
  const [alertsOn, setAlertsOn] = useState(alerts.enabled);
  const [section, setSection] = useState<Section>('general');
  const [form, setForm] = useState({
    language: settings.language, playerName: settings.playerName || t('ui.you'), playerColor: settings.playerColor || '#ff7a59',
    officeName: office?.name || '', floorColor: office?.floorColor || '#f6f7f9', wallColor: office?.wallColor || '#ffffff',
    binaries: { ...settings.binaries }, defaultProvider: settings.defaultProvider || providers[0]?.id || '', defaultModels: { ...settings.defaultModels }, modelOverrides: { ...settings.modelOverrides }, defaultCwd: settings.defaultCwd || '', worktrees: !!settings.worktrees, approveMerges: !!settings.approveMerges, resumeInterrupted: !!settings.resumeInterrupted, github: !!settings.github, approvalPolicy: settings.approvalPolicy ?? '', officeNotes: settings.officeNotes ?? '',
  });
  const [limits, setLimits] = useState(() => ({ ...settings.limits }));
  // `step` is what the arrows add, not a rule: the form has no native validation, the server decides
  const limitField = (k: keyof typeof limits, step = 1, whole = false) => ({
    type: 'number', min: 0, step, value: limits[k],
    onChange: (e: { target: { value: string } }) => {
      const value = Math.max(0, Number(e.target.value) || 0);
      setLimits({ ...limits, [k]: whole ? Math.floor(value) : value });
    },
  });
  const field = (k: Exclude<keyof typeof form, 'binaries' | 'defaultModels' | 'modelOverrides' | 'worktrees' | 'approveMerges' | 'resumeInterrupted' | 'github'>) => ({ value: form[k], onChange: (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value }) });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const { officeName, floorColor, wallColor, binaries, ...rest } = form;
    const cleaned = Object.fromEntries(Object.entries(binaries).map(([id, v]) => [id, v.trim()]));
    saveSettings({ office: { name: officeName.trim() || office?.name || '', floorColor, wallColor }, settings: { ...rest, binaries: cleaned, limits } });
  };
  const reinstall = () => {
    if (agentCount && !confirm(t('settings.reinstallConfirm', { n: agentCount }))) return;
    installDefaultTeam();
  };
  const importFile = useRef<HTMLInputElement>(null);
  const importMode = useRef(false);
  const pickTeamFile = (replace: boolean) => { importMode.current = replace; importFile.current?.click(); };
  const onTeamFile = async (input: HTMLInputElement) => {
    const chosen = input.files?.[0];
    input.value = ''; // the same file can be picked again
    if (!chosen) return;
    const team = readTeamFile(await chosen.text());
    if (!team) { badTeamFile(); return; }
    const replace = importMode.current;
    const question = t(replace ? 'settings.importReplaceConfirm' : 'settings.importAddConfirm', { n: team.file.agents.length, current: agentCount });
    const warning = team.fullAuthority ? `\n\n${t('settings.importFullAuthority', { n: team.fullAuthority })}` : '';
    if (confirm(question + warning)) importTeam(team.file, replace);
  };

  return (
    <>
      <h2>{t('settings.title')}</h2>
      <div className="settings">
        <nav className="settings-nav" role="tablist" aria-orientation="vertical">
          {SECTIONS.map(id => <button key={id} type="button" role="tab" aria-selected={section === id} className={section === id ? 'on' : ''} onClick={() => setSection(id)}>{t(`settings.section.${id}`)}</button>)}
        </nav>
        <form onSubmit={submit} noValidate>
          <div className="settings-body">
            {section === 'general' && <>
            <div className="row">
              <label className="f">{t('settings.playerName')}<input type="text" {...field('playerName')} /></label>
              <label className="f">{t('settings.playerColor')}<input type="color" {...field('playerColor')} /></label>
            </div>
            <label className="f">{t('settings.theme')}
              <select value={theme} onChange={e => setTheme(e.target.value as Theme)}>{THEMES.map(v => <option key={v} value={v}>{t(`theme.${v}`)}</option>)}</select>
            </label>
    <label className="f">{t('settings.quality')}: {t(`quality.${graphics.level}` as `quality.${0 | 1 | 2 | 3}`)}
      <input type="range" min={0} max={MAX_QUALITY} step={1} value={graphics.level} onChange={e => setGraphics({ ...graphics, level: Number(e.target.value) })} />
      <span className="range-ends"><span>{t('quality.performance')}</span><span>{t('quality.quality')}</span></span>
    </label>
    <label className="check"><input type="checkbox" checked={graphics.auto} onChange={e => setGraphics({ ...graphics, auto: e.target.checked })} />{t('settings.qualityAuto')}</label>
    <div className="hint">{t('settings.qualityHint')}</div>
    <label className="f">{t('settings.language')}
              <select {...field('language')}>{LOCALES.map(l => <option key={l} value={l}>{LANGUAGE_NAMES[l]}</option>)}</select>
            </label>
            <label className="f">{t('settings.officeName')}<input type="text" {...field('officeName')} /></label>
            <div className="row">
              <label className="f">{t('settings.floor')}<input type="color" {...field('floorColor')} /></label>
              <label className="f">{t('settings.wall')}<input type="color" {...field('wallColor')} /></label>
            </div>
            {alerts.supported ? (
              <>
                <label className="check"><input type="checkbox" checked={alertsOn} onChange={async e => setAlertsOn(await setAlerts(e.target.checked))} />{t('settings.alerts')}</label>
                <div className="hint">{t('settings.alertsHint')}</div>
              </>
            ) : <div className="hint">{t('settings.alertsUnsupported')}</div>}
            </>}
            {section === 'cli' && <>
            <div className="sec-label">{t('settings.binaries')}</div>
            {providers.map(p => (
              <div key={p.id}>
                <label className="f">{p.label}
                  <input type="text" value={form.binaries[p.id] ?? ''} placeholder={p.path || t('settings.binPh')}
                    onChange={e => setForm({ ...form, binaries: { ...form.binaries, [p.id]: e.target.value } })} />
                </label>
                <div className="hint">
                  <RichText text={cliStatus(p, t)} />
                </div>
                {holds[p.id] && <div className="hint">{holdLabel(holds[p.id]!, settings.language, t)} <button type="button" className="sm" onClick={() => resumeProvider(p.id)}>{t('settings.holdResume')}</button></div>}
              </div>
            ))}
            <label className="f">{t('settings.defaultProvider')}
              <select {...field('defaultProvider')}>
                {providers.map(p => <option key={p.id} value={p.id}>{p.label}{p.available ? '' : ` ${t('form.notFound')}`}</option>)}
              </select>
            </label>
            <div className="hint">{t('settings.defaultProviderHint')}</div>
            <div className="sec-label">{t('settings.models')}</div>
            {providers.filter(p => p.models.length).map(p => {
              const options = p.models.filter(m => m.value).map(m => <option key={m.value} value={m.value}>{m.label}</option>);
              const pick = (k: 'defaultModels' | 'modelOverrides') => ({
                value: form[k][p.id] ?? '', onChange: (e: { target: { value: string } }) => setForm({ ...form, [k]: { ...form[k], [p.id]: e.target.value } }),
              });
              return (
                <div key={p.id}>
                  <div className="sub-label">{p.label}</div>
                  <div className="row">
                    <label className="f">{t('settings.modelDefault')}<select {...pick('defaultModels')}><option value="">{t('settings.modelCli')}</option>{options}</select></label>
                    <label className="f">{t('settings.modelForce')}<select {...pick('modelOverrides')}><option value="">{t('settings.modelOwn')}</option>{options}</select></label>
                  </div>
                </div>
              );
            })}
            <div className="hint"><RichText text={t('settings.modelsHint')} /></div>
            </>}
            {section === 'work' && <>
            <label className="f">{t('settings.cwd')}<input type="text" {...field('defaultCwd')} /></label>
            <div className="hint">{t('settings.cwdHint')}</div>
            <label className="check"><input type="checkbox" checked={form.worktrees} onChange={e => setForm({ ...form, worktrees: e.target.checked })} />{t('settings.worktrees')}</label>
            <div className="hint">{t('settings.worktreesHint')}</div>
            {form.worktrees && <>
              <label className="check"><input type="checkbox" checked={form.approveMerges} onChange={e => setForm({ ...form, approveMerges: e.target.checked })} />{t('settings.approveMerges')}</label>
              <div className="hint">{t('settings.approveMergesHint')}</div>
            </>}
            <label className="check"><input type="checkbox" checked={form.github} onChange={e => setForm({ ...form, github: e.target.checked })} />{t('settings.github')}</label>
            <div className="hint"><RichText text={t('settings.githubHint')} /> <button type="button" className="sm" onClick={refreshVisitors}>{t('settings.githubRefresh')}</button></div>
            <label className="check"><input type="checkbox" checked={form.resumeInterrupted} onChange={e => setForm({ ...form, resumeInterrupted: e.target.checked })} />{t('settings.resume')}</label>
            <div className="hint">{t('settings.resumeHint')}</div>
            </>}
            {section === 'limits' && <>
            <div className="row">
              <label className="f">{t('settings.dailyBudget')}<input {...limitField('dailyBudgetUsd', 0.5)} /></label>
              <label className="f">{t('settings.agentBudget')}<input {...limitField('agentDailyBudgetUsd', 0.5)} /></label>
              <label className="f">{t('settings.dailyMinutes')}<input {...limitField('dailyRunMinutes', 30)} /></label>
            </div>
            <div className="row">
              <label className="f">{t('settings.maxConcurrent')}<input {...limitField('maxConcurrent', 1, true)} /></label>
              <label className="f">{t('settings.timeout')}<input {...limitField('taskTimeoutMin', 5)} /></label>
              <label className="f">{t('settings.silence')}<input {...limitField('silenceTimeoutMin', 5)} /></label>
            </div>
            <div className="hint">{t('settings.limitsHint')}</div>
            <div className="row">
              <label className="f">{t('settings.chainTurns')}<input {...limitField('chainMaxTurns', 10, true)} /></label>
              <label className="f">{t('settings.chainBudget')}<input {...limitField('chainBudgetUsd', 1)} /></label>
            </div>
            <div className="hint">{t('settings.chainHint')}</div>
            </>}
            {section === 'rules' && <>
            <label className="f">{t('settings.approvalPolicy')}<textarea rows={2} {...field('approvalPolicy')} /></label>
            <div className="hint">{t('settings.approvalPolicyHint')}</div>
            <label className="f">{t('settings.officeNotes')}<textarea rows={3} maxLength={MAX_OFFICE_NOTES_CHARS} {...field('officeNotes')} /></label>
            <div className="hint">{t('settings.officeNotesHint')}</div>
            </>}
            {section === 'team' && <>
            <div className="sec-label">{t('side.team')}</div>
            <div className="hint"><RichText text={t('settings.teamHint')} /></div>
            <div className="row">
              <button type="button" onClick={() => confirm(t('settings.refreshRolesConfirm')) && refreshDefaultRoles()}>{t('settings.refreshRoles')}</button>
              <button type="button" onClick={reinstall}>{t('settings.installTeam')}</button>
            </div>
            <div className="hint">{t('settings.refreshRolesHint')}</div>
            <div className="row">
              <a className="button-link" href="/api/team/export" download>{t('settings.exportTeam')}</a>
              <button type="button" onClick={() => pickTeamFile(false)}>{t('settings.importAdd')}</button>
              <button type="button" onClick={() => pickTeamFile(true)}>{t('settings.importReplace')}</button>
              <input ref={importFile} type="file" accept="application/json,.json" hidden onChange={e => onTeamFile(e.currentTarget)} />
            </div>
            <div className="hint">{t('settings.teamFileHint')}</div>
            <button type="button" className="danger" disabled={!agentCount} onClick={() => confirm(t('settings.deleteTeamConfirm', { n: agentCount })) && deleteTeam()}>{t('settings.deleteTeam')}</button>
            <div className="sec-label">{t('settings.data')}</div>
            <a className="button-link" href="/api/export" download>{t('settings.export')}</a>
            <div className="hint"><RichText text={t('settings.exportHint')} /></div>
            </>}
          </div>
          <div className="row end"><button type="button" onClick={closeModal}>{t('ui.close')}</button><button className="primary" type="submit">{t('ui.save')}</button></div>
        </form>
      </div>
    </>
  );
}
