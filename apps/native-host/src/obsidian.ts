import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exportMarkdown, type MeetingSession, type TranscriptSegment } from '@scribetab/shared';
import { meetingDirBase } from './slug.js';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function sessionIdFromMarkdown(text: string): string | undefined {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return undefined;
  const line = m[1]!.split(/\r?\n/).find((l) => l.startsWith('sessionId:'));
  if (!line) return undefined;
  const v = line.slice('sessionId:'.length).trim();
  return v || undefined;
}

export function obsidianMarkdown(
  session: MeetingSession,
  segments: TranscriptSegment[],
  summaryMarkdown?: string,
): string {
  const body = exportMarkdown(session, segments, { summaryMarkdown });
  return `---\nsessionId: ${session.id}\n---\n${body}`;
}

async function lexists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return false;
    throw e;
  }
}

export async function uniqueMarkdownPath(dir: string, base: string): Promise<string> {
  const first = join(dir, `${base}.md`);
  if (!(await lexists(first))) return first;
  for (let n = 2; n < 10_000; n++) {
    const p = join(dir, `${base}-${n}.md`);
    if (!(await lexists(p))) return p;
  }
  throw new Error(`Too many slug collisions for ${base}.md`);
}

async function findFileBySessionId(dir: string, sessionId: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return undefined;
    throw e;
  }
  for (const name of names) {
    if (!name.endsWith('.md') || name.startsWith('.')) continue;
    const path = join(dir, name);
    try {
      const st = await lstat(path);
      if (st.isSymbolicLink() || !st.isFile()) continue;
    } catch {
      continue;
    }
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    if (sessionIdFromMarkdown(text) === sessionId) return path;
  }
  return undefined;
}

export async function assertVaultDir(vaultPath: string): Promise<void> {
  let st;
  try {
    st = await lstat(vaultPath);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new Error(`Obsidian vault path does not exist: ${vaultPath}`);
    }
    throw e;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`Obsidian vault path is a symlink: ${vaultPath}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`Obsidian vault path is not a directory: ${vaultPath}`);
  }
}

export async function copyToObsidian(opts: {
  vaultPath: string;
  session: MeetingSession;
  segments: TranscriptSegment[];
  summaryMarkdown?: string;
}): Promise<string> {
  await assertVaultDir(opts.vaultPath);
  const outDir = join(opts.vaultPath, 'ScribeTab');
  try {
    const st = await lstat(outDir);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to write through symlink: ${outDir}`);
    }
    if (!st.isDirectory()) {
      throw new Error(`Obsidian ScribeTab path is not a directory: ${outDir}`);
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      await mkdir(outDir, { recursive: true });
    } else {
      throw e;
    }
  }
  const existing = await findFileBySessionId(outDir, opts.session.id);
  const dest =
    existing ?? (await uniqueMarkdownPath(outDir, meetingDirBase(opts.session.startedAt, opts.session.title)));
  try {
    const st = await lstat(dest);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to write through symlink: ${dest}`);
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') throw e;
  }
  const tmp = join(outDir, `.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, obsidianMarkdown(opts.session, opts.segments, opts.summaryMarkdown), 'utf8');
    await rename(tmp, dest);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  return dest;
}
