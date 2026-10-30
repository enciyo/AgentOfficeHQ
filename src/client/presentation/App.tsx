import { useEffect } from 'react';
import type { StageHolder } from '../infrastructure/stageHolder.ts';
import { Inspector } from './Inspector.tsx';
import { ModalHost } from './Modals.tsx';
import { Sidebar } from './Sidebar.tsx';
import { StagePanel } from './StagePanel.tsx';
import { TopBar } from './TopBar.tsx';
import { useActions, useLocale, useOffice } from './store.tsx';

const Toasts = () => {
  const toasts = useOffice(s => s.toasts);
  return <div id="toast" role="status" aria-live="polite">{toasts.map(t => <div key={t.id}>{t.text}</div>)}</div>;
};

export function App({ holder }: { holder: StageHolder }) {
  const { init, escape, setDark } = useActions();
  const theme = useOffice(s => s.theme);
  const locale = useLocale();

  useEffect(() => { document.documentElement.lang = locale; }, [locale]);

  // Runs after StagePanel attached the 3D world (children's effects run first)
  useEffect(() => { init(); }, [init]);

  // The theme reaches the CSS and the 3D office
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme; else root.dataset.theme = theme;
    const system = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => setDark(theme === 'dark' || (theme === 'system' && system.matches));
    apply();
    system.addEventListener('change', apply);
    return () => system.removeEventListener('change', apply);
  }, [theme, setDark]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = document.activeElement as HTMLElement | null;
      if (el && /INPUT|TEXTAREA|SELECT/.test(el.tagName)) return el.blur();
      escape();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [escape]);

  return (
    <>
      <TopBar />
      <div className="layout">
        <Sidebar />
        <StagePanel holder={holder} />
        <Inspector />
      </div>
      <ModalHost />
      <Toasts />
    </>
  );
}
