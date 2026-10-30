// Composition root: wires infrastructure into the application store and mounts the UI.
import { createRoot } from 'react-dom/client';
import { resolveLocale } from '../shared/i18n/index.ts';
import { createOfficeStore } from './application/officeStore.ts';
import { browserStorage, httpGateway, sseEvents } from './infrastructure/httpGateway.ts';
import { browserAlerts } from './infrastructure/browserAlerts.ts';
import { StageHolder } from './infrastructure/stageHolder.ts';
import { App } from './presentation/App.tsx';
import { OfficeProvider } from './presentation/store.tsx';

const stage = new StageHolder();
const store = createOfficeStore({ gateway: httpGateway, events: sseEvents, stage, storage: browserStorage, alerts: browserAlerts, locale: resolveLocale(navigator.language), lightDevice: matchMedia('(pointer: coarse)').matches || innerWidth < 768 });

// Before the first paint, so a chosen theme does not flash the system's
const { theme } = store.getState();
if (theme !== 'system') document.documentElement.dataset.theme = theme;

createRoot(document.getElementById('root')!).render(
  <OfficeProvider value={store}>
    <App holder={stage} />
  </OfficeProvider>,
);
