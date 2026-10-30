// The output browser lists and reads only inside the working directory: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalFileTree } from './localFileTree.ts';

test('lists files, skips noise and refuses paths outside the root', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-files-'));
  const root = path.join(tmp, 'work');
  fs.mkdirSync(path.join(root, 'docs/req-1'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules/x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/req-1/plan.md'), '# Plan');
  fs.writeFileSync(path.join(root, 'node_modules/x/index.js'), '');
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([1, 0, 2]));
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'nope');
  fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(root, 'link.txt'));

  const files = new LocalFileTree();
  const listed = files.list(root).map(f => f.path).sort();
  assert.ok(listed.includes('docs/req-1/plan.md'));
  assert.ok(!listed.some(p => p.startsWith('node_modules')));

  assert.equal(files.read(root, 'docs/req-1/plan.md')?.text, '# Plan');
  assert.equal(files.read(root, 'blob.bin')?.binary, true);
  assert.equal(files.read(root, '../secret.txt'), null);
  assert.equal(files.read(root, path.join(tmp, 'secret.txt')), null);
  assert.equal(files.read(root, 'link.txt'), null, 'symlinks out of the root are refused');
  assert.equal(files.read(root, 'docs'), null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('raw bytes and deletes stay inside the root and never touch repository state', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-files-'));
  const root = path.join(tmp, 'work');
  fs.mkdirSync(path.join(root, 'site/css'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'site/index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(root, 'site/css/a.css'), 'h1{}');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'nope');
  fs.symlinkSync(tmp, path.join(root, 'out'));
  const files = new LocalFileTree();

  assert.equal(files.raw(root, 'site/index.html')?.toString(), '<h1>hi</h1>');
  assert.equal(files.raw(root, '../secret.txt'), null);
  assert.equal(files.raw(root, 'out/secret.txt'), null, 'not through a symlinked folder');
  assert.equal(files.raw(root, 'site'), null, 'folders have no bytes');

  assert.equal(files.remove(root, ''), false, 'never the working directory itself');
  assert.equal(files.remove(root, '.'), false);
  assert.equal(files.remove(root, '../secret.txt'), false);
  assert.equal(files.remove(root, 'out/secret.txt'), false);
  assert.equal(files.remove(root, '.git'), false);
  assert.equal(files.remove(root, '.GIT'), false, 'case-insensitive file systems');
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{}');
  assert.equal(files.remove(root, '.claude'), false, 'tool state is not listed, so it cannot be deleted');
  assert.equal(files.remove(root, '.claude/settings.json'), false);
  assert.equal(files.remove(root, 'missing.md'), false);
  assert.ok(fs.existsSync(path.join(tmp, 'secret.txt')));

  assert.equal(files.remove(root, 'out'), true, 'a symlink is removed, not what it points to');
  assert.ok(fs.existsSync(path.join(tmp, 'secret.txt')));
  assert.equal(files.remove(root, 'site/css/a.css'), true);
  assert.equal(files.remove(root, 'site'), true, 'folders go with their contents');
  assert.ok(!fs.existsSync(path.join(root, 'site')));
  fs.rmSync(tmp, { recursive: true, force: true });
});
