import { createT, type Locale, type Translate } from '../../shared/i18n/index.ts';
import type { StateStore } from '../domain/ports.ts';

/** Translates server-side text (errors, logs, prompts) into the language chosen in the settings. */
export class Translator {
  constructor(private readonly store: StateStore) {}

  get locale(): Locale { return this.store.state.settings.language; }

  /** Always reads the current language, so a settings change applies immediately. */
  t: Translate = (key, params) => createT(this.locale)(key, params);
}
