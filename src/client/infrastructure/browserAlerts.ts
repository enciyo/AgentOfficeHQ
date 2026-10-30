import type { Alerts } from '../application/ports.ts';
import { browserStorage } from './httpGateway.ts';

const KEY = 'agent-office:alerts';
const supported = typeof Notification !== 'undefined';

/** Desktop notifications, shown only while the tab is in the background. */
export const browserAlerts: Alerts = {
  supported,
  enabled: () => supported && Notification.permission === 'granted' && browserStorage.get(KEY) === '1',
  async setEnabled(on) {
    if (!supported) return false;
    if (on && Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') return false;
    browserStorage.set(KEY, on ? '1' : '0');
    return on;
  },
  show(title, body, onClick) {
    if (!this.enabled() || !document.hidden) return;
    const n = new Notification(title, { body, tag: title });
    n.onclick = () => { window.focus(); onClick?.(); n.close(); };
  },
};
