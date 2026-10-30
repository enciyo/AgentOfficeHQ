// The files agents produce in a working directory: listing, reading, previewing and deleting, never outside it.
import fs from 'node:fs';
import path from 'node:path';
import type { FileEntry, FileTree } from '../domain/ports.ts';

const SKIP = new Set(['node_modules', '.git', '.agent-worktrees', 'dist', 'build', '.next', '.venv', '__pycache__']);
const MAX_ENTRIES = 3000;
const MAX_READ = 512 * 1024;
const MAX_RAW = 20 * 1024 * 1024;

/** `rel` inside `root` as an absolute path, or null when it would leave the root (../, absolute paths, symlinks out). */
function inside(root: string, rel: string) {
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  if (!full.startsWith(base + path.sep)) return null;
  try {
    // The parent must really be inside (a symlinked folder could point anywhere); the entry itself may be a link
    const realBase = fs.realpathSync(base), realParent = fs.realpathSync(path.dirname(full));
    if (realParent !== realBase && !realParent.startsWith(realBase + path.sep)) return null;
  } catch {
    return null;
  }
  return full;
}

export class LocalFileTree implements FileTree {
  list(root: string): FileEntry[] {
    const out: FileEntry[] = [];
    const walk = (dir: string) => {
      let names: fs.Dirent[];
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of names) {
        if (out.length >= MAX_ENTRIES) return;
        // dot-folders are tool state (.git, .serena, .claude, ...), not outputs
        if (SKIP.has(d.name) || d.name === '.DS_Store' || (d.isDirectory() && d.name.startsWith('.'))) continue;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) walk(full);
        else if (d.isFile()) {
          try {
            const st = fs.statSync(full);
            out.push({ path: path.relative(root, full).split(path.sep).join('/'), size: st.size, mtime: st.mtimeMs });
          } catch {}
        }
      }
    };
    walk(root);
    return out;
  }

  read(root: string, rel: string): { text: string; truncated: boolean; binary: boolean } | null {
    const full = this.file(root, rel);
    if (!full) return null;
    try {
      const st = fs.statSync(full);
      const fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(Math.min(st.size, MAX_READ));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const binary = buf.subarray(0, 8000).includes(0);
      return { text: binary ? '' : buf.toString('utf8'), truncated: st.size > MAX_READ, binary };
    } catch {
      return null;
    }
  }

  raw(root: string, rel: string): Buffer | null {
    const full = this.file(root, rel);
    try { return full && fs.statSync(full).size <= MAX_RAW ? fs.readFileSync(full) : null; } catch { return null; }
  }

  remove(root: string, rel: string): boolean {
    const full = inside(root, rel);
    if (!full) return false;
    // Only what the browser lists can go: repository and tool state is not an output. Compared case-insensitively,
    // since macOS file systems are (.GIT is .git).
    const parts = path.relative(path.resolve(root), full).split(path.sep);
    if (parts.some((part, i) => SKIP.has(part.toLowerCase()) || (part.startsWith('.') && i < parts.length - 1))) return false;
    try {
      if (fs.lstatSync(full).isDirectory() && parts.at(-1)!.startsWith('.')) return false;
      fs.rmSync(full, { recursive: true, force: true }); // a symlink is removed, not followed
      return true;
    } catch {
      return false;
    }
  }

  /** A regular file inside the root, following no symlink out of it. */
  private file(root: string, rel: string) {
    const full = inside(root, rel);
    if (!full) return null;
    try {
      const realBase = fs.realpathSync(path.resolve(root)), real = fs.realpathSync(full);
      return real.startsWith(realBase + path.sep) && fs.statSync(real).isFile() ? full : null;
    } catch {
      return null;
    }
  }
}
