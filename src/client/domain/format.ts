import type { Locale, TKey, Translate } from '../../shared/i18n/index.ts';

const DATE_LOCALES: Record<Locale, string> = { tr: 'tr-TR', en: 'en-US' };

export const statusLabel = (t: Translate, status: string) => t(`status.${status}` as TKey);
export const taskStatusLabel = (t: Translate, status: string) => t(`taskStatus.${status}` as TKey);

export const formatTime = (ts: number, locale: Locale) => new Date(ts).toLocaleTimeString(DATE_LOCALES[locale], { hour: '2-digit', minute: '2-digit' });
export const compareNames = (locale: Locale) => (a: string, b: string) => a.localeCompare(b, locale);
export const initials = (name: string) => name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const formatDuration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
export const formatDateTime = (ts: number, locale: Locale) => new Date(ts).toLocaleString(DATE_LOCALES[locale], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
