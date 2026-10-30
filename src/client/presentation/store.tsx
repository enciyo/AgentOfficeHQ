import { createContext, useContext, useMemo } from 'react';
import { useStore } from 'zustand';
import { createT, type Locale, type Translate } from '../../shared/i18n/index.ts';
import type { OfficeState, OfficeStore } from '../application/officeStore.ts';

const OfficeContext = createContext<OfficeStore>(null!);
export const OfficeProvider = OfficeContext.Provider;

/** Subscribe to a slice of state. Selectors must return existing references (derive with useMemo). */
export const useOffice = <T,>(selector: (s: OfficeState) => T) => useStore(useContext(OfficeContext), selector);
export const useActions = () => useContext(OfficeContext).actions;

/** Translate function for the language chosen in the settings. */
export function useT(): Translate {
  const language = useOffice(s => s.settings.language);
  return useMemo(() => createT(language), [language]);
}

export const useLocale = (): Locale => useOffice(s => s.settings.language);
