import type { Stage } from '../application/ports.ts';

/**
 * Stage that forwards to the 3D world once it is mounted. three.js loads after the UI, so what the office says until
 * then is kept and replayed in order.
 */
export class StageHolder implements Stage {
  private world: Stage | null = null;
  private waiting: ((world: Stage) => void)[] = [];

  attach(world: Stage) {
    this.world = world;
    this.waiting.forEach(call => call(world));
    this.waiting = [];
  }

  private send(call: (world: Stage) => void) {
    if (this.world) call(this.world);
    else this.waiting.push(call);
  }

  setDark: Stage['setDark'] = (dark) => this.send(w => w.setDark(dark));
  setCovered: Stage['setCovered'] = (covered) => this.send(w => w.setCovered(covered));
  setGraphics: Stage['setGraphics'] = (g) => this.send(w => w.setGraphics(g));
  setLanguage: Stage['setLanguage'] = (t) => this.send(w => w.setLanguage(t));
  setPlayer: Stage['setPlayer'] = (i) => this.send(w => w.setPlayer(i));
  setOffice: Stage['setOffice'] = (o) => this.send(w => w.setOffice(o));
  setAgents: Stage['setAgents'] = (a) => this.send(w => w.setAgents(a));
  upsertAgent: Stage['upsertAgent'] = (a) => this.send(w => w.upsertAgent(a));
  removeAgent: Stage['removeAgent'] = (id) => this.send(w => w.removeAgent(id));
  selectAgent: Stage['selectAgent'] = (id) => this.send(w => w.selectAgent(id));
  focusAgent: Stage['focusAgent'] = (id) => this.send(w => w.focusAgent(id));
  focusZone: Stage['focusZone'] = (id) => this.send(w => w.focusZone(id));
  handoff: Stage['handoff'] = (id) => this.send(w => w.handoff(id));
  flash: Stage['flash'] = (id, t, ms) => this.send(w => w.flash(id, t, ms));
  setAttention: Stage['setAttention'] = (s) => this.send(w => w.setAttention(s));
  courier: Stage['courier'] = (f, t, m) => this.send(w => w.courier(f, t, m));
  setVisitors: Stage['setVisitors'] = (v) => this.send(w => w.setVisitors(v));
  setMorale: Stage['setMorale'] = (m) => this.send(w => w.setMorale(m));
  setWeather: Stage['setWeather'] = (weather) => this.send(w => w.setWeather(weather));
  watched: Stage['watched'] = () => this.world?.watched() ?? false;
  fireDrill: Stage['fireDrill'] = (ms) => this.send(w => w.fireDrill(ms));
  standup: Stage['standup'] = (l) => this.send(w => w.standup(l));
  coffeeBreak: Stage['coffeeBreak'] = () => this.send(w => w.coffeeBreak());
  cheer: Stage['cheer'] = (id, e) => this.send(w => w.cheer(id, e));
  setActionMode: Stage['setActionMode'] = (mode) => this.send(w => w.setActionMode(mode));
}
