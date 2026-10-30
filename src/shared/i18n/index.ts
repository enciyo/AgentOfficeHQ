// Localization: Turkish and English catalogs and the `t()` helper. Every user-facing string goes through here.
import { en } from './en.ts';
import { tr } from './tr.ts';

export const LOCALES = ['tr', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export type TKey = keyof typeof tr;

const CATALOGS: Record<Locale, Record<TKey, string>> = { tr, en };
export type Translate = (key: TKey, params?: Record<string, string | number>) => string;

export const DEFAULT_LOCALE: Locale = 'tr';

const isLocale = (v: unknown): v is Locale => (LOCALES as readonly unknown[]).includes(v);

/** "en-US" / "tr_TR.UTF-8" → "en" / "tr"; unsupported values fall back to the default. */
export function resolveLocale(raw = ''): Locale {
  const code = raw.slice(0, 2).toLowerCase();
  return isLocale(code) ? code : DEFAULT_LOCALE;
}

/** Fills `{name}` placeholders; unknown placeholders are left as they are. */
export const fill = (text: string, params: Record<string, string | number> = {}) =>
  text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));

/** Unknown keys come back as the key itself so they are visible, not silent. */
export function createT(locale: Locale): Translate {
  const catalog: Record<string, string> = CATALOGS[isLocale(locale) ? locale : DEFAULT_LOCALE];
  return (key, params) => fill(catalog[key] ?? key, params);
}
