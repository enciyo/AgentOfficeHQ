import { useMemo } from 'react';
import type { TKey } from '../../shared/i18n/index.ts';
import { COLORS, PERMISSION_MODES, type AgentDraft } from '../domain/agentForm.ts';
import { compareNames } from '../domain/format.ts';
import { RichText } from './common.tsx';
import { useLocale, useOffice, useT } from './store.tsx';

interface Props { draft: AgentDraft; onChange: (draft: AgentDraft) => void; isNew: boolean }

export function AgentForm({ draft, onChange, isNew }: Props) {
  const t = useT();
  const locale = useLocale();
  const agents = useOffice(s => s.agents);
  const presets = useOffice(s => s.presets);
  const providers = useOffice(s => s.providers);
  const defaultCwd = useOffice(s => s.settings.defaultCwd);
  const defaultModels = useOffice(s => s.settings.defaultModels);
  const modelOverrides = useOffice(s => s.settings.modelOverrides);
  const teams = useMemo(() => [...new Set(Object.values(agents).map(a => a.team).filter(Boolean))].sort(compareNames(locale)), [agents, locale]);

  const defaultProvider = useOffice(s => s.settings.defaultProvider);
  const officeCli = providers.find(p => p.id === defaultProvider) ?? providers[0];
  // '' follows the office default CLI
  const provider = providers.find(p => p.id === draft.provider) ?? officeCli;
  const set = (patch: Partial<AgentDraft>) => onChange({ ...draft, ...patch });
  const text = (field: keyof AgentDraft) => ({ value: draft[field], onChange: (e: { target: { value: string } }) => set({ [field]: e.target.value }) });
  const isAgent = draft.kind === 'agent';

  const applyPreset = (id: string) => {
    const p = presets.find(x => x.id === id);
    if (p) set({ role: p.role, prompt: p.prompt, color: p.color, allowedTools: p.allowedTools, permissionMode: p.permissionMode });
  };
  const setKind = (kind: AgentDraft['kind']) => set({ kind, role: kind === 'human' && !draft.role ? t('role.owner') : draft.role });

  return (
    <>
      {isNew && (
        <div className="kind-toggle">
          <button type="button" className={isAgent ? 'active' : ''} onClick={() => setKind('agent')}><b>{t('form.kindAgent')}</b><small>{t('form.kindAgentHint')}</small></button>
          <button type="button" className={!isAgent ? 'active' : ''} onClick={() => setKind('human')}><b>{t('form.kindHuman')}</b><small>{t('form.kindHumanHint')}</small></button>
        </div>
      )}
      <div className="row">
        <label className="f">{t('form.name')}<input type="text" {...text('name')} placeholder={t('form.namePh')} required autoFocus={isNew} /></label>
        <label className="f">{t('form.team')}
          <input type="text" {...text('team')} placeholder={t('form.teamPh')} list="team-list-opts" />
          <datalist id="team-list-opts">{teams.map(t => <option key={t} value={t} />)}</datalist>
        </label>
      </div>
      <div className="hint">{t('form.teamHint')}</div>
      {isAgent && isNew && (
        <label className="f">{t('form.preset')}
          <select defaultValue="" onChange={e => applyPreset(e.target.value)}>
            <option value="">{t('form.presetCustom')}</option>
            {presets.map(p => <option key={p.id} value={p.id}>{p.role}</option>)}
          </select>
        </label>
      )}
      <label className="f">{t('form.role')}<input type="text" {...text('role')} placeholder={t('form.rolePh')} /></label>
      <label className="f">{t('form.color')}
        <div className="swatches">
          {COLORS.map(c => <button key={c} type="button" style={{ background: c }} className={c === draft.color ? 'on' : ''} onClick={() => set({ color: c })} />)}
        </div>
      </label>
      {isAgent && (
        <>
          <label className="f">{t('form.prompt')}<textarea rows={4} {...text('prompt')} placeholder={t('form.promptPh')} /></label>
          <div className="row">
            <label className="f">{t('form.provider')}
              <select {...text('provider')}>
                <option value="">{t('form.providerOffice', { label: officeCli?.label ?? '' })}</option>
                {providers.map(p => <option key={p.id} value={p.id}>{p.label}{p.available ? '' : ` ${t('form.notFound')}`}</option>)}
              </select>
            </label>
            <label className="f">{t('form.model')}
              <input type="text" {...text('model')} placeholder={provider && defaultModels?.[provider.id] ? t('form.modelOffice', { model: defaultModels[provider.id]! }) : t('form.modelDefault')} list="model-opts" />
              <datalist id="model-opts">{provider?.models.filter(m => m.value).map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</datalist>
            </label>
          </div>
          <div className="hint">{provider && !provider.delegation && t('form.noDelegation', { label: provider.label })}</div>
          {provider && modelOverrides?.[provider.id] && <div className="hint">{t('form.modelForced', { model: modelOverrides[provider.id]!, label: provider.label })}</div>}
          <div className="row">
            <label className="f">{t('form.permission')}<select {...text('permissionMode')}>{PERMISSION_MODES.map(v => <option key={v} value={v}>{t(`perm.${v}` as TKey)}</option>)}</select></label>
          </div>
          <label className="f">{t('form.cwd')}<input type="text" {...text('cwd')} placeholder={t('form.cwdPh', { path: defaultCwd || '' })} /></label>
          <label className="f">{t('form.tools')}<input type="text" {...text('allowedTools')} placeholder={t('form.toolsPh')} /></label>
          <div className="hint"><RichText text={t('form.toolsHint')} /></div>
        </>
      )}
    </>
  );
}
