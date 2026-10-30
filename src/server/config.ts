import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PORT = Number(process.env.PORT || 4317);
/** Interface to listen on. 127.0.0.1 = this machine only; 0.0.0.0 = reachable from the local network too. */
export const HOST = process.env.HOST || '127.0.0.1';
export const DATA = process.env.AGENT_OFFICE_DATA || path.join(ROOT, 'data'); // a separate data directory can be given for experiments
export const MCP_SERVER = path.join(ROOT, 'src', 'mcp', 'office-mcp.ts');
export const TSX_BIN = path.join(ROOT, 'node_modules', '.bin', 'tsx');
