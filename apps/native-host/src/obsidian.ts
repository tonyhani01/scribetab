import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

export function uniqueMarkdownPath(
  dir: string,
  base: string,
  exists: (p: string) => boolean = existsSync,
): string {
  const first = join(dir, `${base}.md`);
  if (!exists(first)) return first;
  for (let n = 2; n < 10_000; n++) {
    const p = join(dir, `${base}-${n}.md`);
    if (!exists(p)) return p;
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
    st = await stat(vaultPath);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new Error(`Obsidian vault path does not exist: ${vaultPath}`);
    }
    throw e;
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
  await mkdir(outDir, { recursive: true });
  const existing = await findFileBySessionId(outDir, opts.session.id);
  const dest =
    existing ?? uniqueMarkdownPath(outDir, meetingDirBase(opts.session.startedAt, opts.session.title));
  await writeFile(dest, obsidianMarkdown(opts.session, opts.segments, opts.summaryMarkdown), 'utf8');
  return dest;
}
