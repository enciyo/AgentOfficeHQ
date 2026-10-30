import type { Gateway, ServerEvent, EventFeed } from '../application/ports.ts';

async function request(method: string, path: string, body?: object) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const agent = (id: string) => `/api/agents/${id}`;

export const httpGateway: Gateway = {
  loadState: () => request('GET', '/api/state'),
  hire: (payload) => request('POST', '/api/agents', payload),
  updateAgent: (id, payload) => request('PATCH', agent(id), payload),
  fire: (id) => request('DELETE', agent(id)),
  resetMemory: (id) => request('POST', `${agent(id)}/reset`),
  stop: (id) => request('POST', `${agent(id)}/stop`),
  assign: (id, prompt) => request('POST', `${agent(id)}/tasks`, { prompt }),
  complete: (taskId, result) => request('POST', `/api/tasks/${taskId}/complete`, { result }),
  cancel: (taskId) => request('POST', `/api/tasks/${taskId}/cancel`),
  cancelChain: (taskId) => request('POST', `/api/tasks/${taskId}/cancel-chain`),
  releaseReport: (taskId) => request('POST', `/api/tasks/${taskId}/release`),
  retry: (taskId) => request('POST', `/api/tasks/${taskId}/retry`),
  resolveConflict: (taskId) => request('POST', `/api/tasks/${taskId}/resolve`),
  taskDiff: (taskId) => request('GET', `/api/tasks/${taskId}/diff`),
  editTask: (taskId, prompt) => request('PATCH', `/api/tasks/${taskId}`, { prompt }),
  setPaused: (paused) => request('POST', '/api/office/pause', { paused }),
  resumeProvider: (id) => request('POST', `/api/providers/${id}/resume`),
  refreshDefaultRoles: async () => (await request('POST', '/api/team/refresh-roles')).updated,
  installDefaultTeam: async () => (await request('POST', '/api/team/defaults', { replace: true })).added,
  deleteTeam: async () => (await request('DELETE', '/api/team')).removed,
  importTeam: (file, replace) => request('POST', '/api/team/import', { ...file, replace }),
  updateOffice: (fields) => request('PUT', '/api/office', fields),
  updateSettings: (fields) => request('PUT', '/api/settings', fields),
  logs: (id) => request('GET', `${agent(id)}/logs`),
  taskLogs: (id) => request('GET', `/api/tasks/${id}/logs`),
  createSchedule: (fields) => request('POST', '/api/schedules', fields),
  updateSchedule: (id, fields) => request('PATCH', `/api/schedules/${id}`, fields),
  deleteSchedule: (id) => request('DELETE', `/api/schedules/${id}`),
  decideApproval: (id, approve, note) => request('POST', `/api/approvals/${id}/decide`, { approve, note }),
  updateNote: (id, fields) => request('PATCH', `/api/notes/${id}`, fields),
  deleteNote: (id) => request('DELETE', `/api/notes/${id}`),
  files: () => request('GET', '/api/files'),
  fileContent: (path) => request('GET', `/api/files/content?path=${encodeURIComponent(path)}`),
  deleteFile: (path) => request('DELETE', `/api/files?path=${encodeURIComponent(path)}`),
  fileUrl: (path, download = false) => `/api/files/raw/${path.split('/').map(encodeURIComponent).join('/')}${download ? '?download' : ''}`,
  handoff: (taskId, agentId) => request('POST', `/api/tasks/${taskId}/handoff`, { agentId }),
  react: (taskId, emoji) => request('POST', `/api/tasks/${taskId}/react`, { emoji }),
  openPullRequest: (taskId) => request('POST', `/api/tasks/${taskId}/pr`),
  refreshVisitors: () => request('POST', '/api/visitors/refresh'),
  acceptVisitor: (id, agentId) => request('POST', `/api/visitors/${id}/accept`, { agentId }),
  rejectVisitor: (id) => request('POST', `/api/visitors/${id}/reject`),
};

/** How soon to connect again when the browser gave up on the feed. */
const RECONNECT_MS = 2000;

export const sseEvents: EventFeed = {
  subscribe(onEvent, onReconnect) {
    let lost = false;
    const connect = () => {
      const source = new EventSource('/api/events');
      source.onmessage = (e) => onEvent(JSON.parse(e.data) as ServerEvent);
      source.onopen = () => {
        if (lost) onReconnect();
        lost = false;
      };
      source.onerror = () => {
        lost = true;
        // It retries by itself, except after an answer that is no stream: a dev proxy with no server behind it
        if (source.readyState === EventSource.CLOSED) setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();
  },
};

export const browserStorage = {
  get(key: string) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key: string, value: string) { try { localStorage.setItem(key, value); } catch {} },
};
