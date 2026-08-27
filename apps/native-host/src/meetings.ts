import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MeetingSession, TranscriptSegment } from '@scribetab/shared';

export interface MeetingRecord {
  dirName: string;
  path: string;
  session?: MeetingSession;
  segments: TranscriptSegment[];
  transcriptMd: string;
  summaryMd?: string;
  hasAudio: boolean;
  mtimeMs: number;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return undefined;
    throw e;
  }
}

export async function loadMeeting(dirPath: string, dirName: string): Promise<MeetingRecord> {
  const transcriptMd = (await readOptional(join(dirPath, 'transcript.md'))) ?? '';
  const jsonText = await readOptional(join(dirPath, 'transcript.json'));
  const summaryMd = await readOptional(join(dirPath, 'summary.md'));
  let session: MeetingSession | undefined;
  let segments: TranscriptSegment[] = [];
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as { session?: MeetingSession; segments?: TranscriptSegment[] };
      session = parsed.session;
      segments = parsed.segments ?? [];
    } catch {
      // keep markdown-only
    }
  }
  let hasAudio = false;
  let mtimeMs = 0;
  try {
    const st = await stat(join(dirPath, 'audio.wav'));
    hasAudio = st.isFile();
  } catch {
    hasAudio = false;
  }
  try {
    mtimeMs = (await stat(dirPath)).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  return { dirName, path: dirPath, session, segments, transcriptMd, summaryMd, hasAudio, mtimeMs };
}

export async function listMeetings(root: string): Promise<MeetingRecord[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return [];
    throw e;
  }
  const out: MeetingRecord[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const path = join(root, name);
    const st = await stat(path);
    if (!st.isDirectory()) continue;
    out.push(await loadMeeting(path, name));
  }
  out.sort((a, b) => {
    const at = a.session?.startedAt ?? a.dirName;
    const bt = b.session?.startedAt ?? b.dirName;
    return bt.localeCompare(at) || b.mtimeMs - a.mtimeMs;
  });
  return out;
}

export async function getMeeting(root: string, id: string): Promise<MeetingRecord | undefined> {
  const all = await listMeetings(root);
  return all.find((m) => m.dirName === id || m.session?.id === id);
}

export async function getLatestMeeting(root: string): Promise<MeetingRecord | undefined> {
  const all = await listMeetings(root);
  return all[0];
}

export async function searchMeetings(root: string, query: string): Promise<MeetingRecord[]> {
  const q = query.trim().toLowerCase();
  if (!q) return listMeetings(root);
  const all = await listMeetings(root);
  return all.filter((m) => {
    const hay = `${m.transcriptMd}\n${m.session?.title ?? ''}\n${m.summaryMd ?? ''}`.toLowerCase();
    return hay.includes(q);
  });
}

export function meetingToText(m: MeetingRecord): string {
  const header = [
    `dir: ${m.dirName}`,
    m.session ? `id: ${m.session.id}` : null,
    m.session ? `title: ${m.session.title}` : null,
    `path: ${m.path}`,
    `audio: ${m.hasAudio ? 'yes' : 'no'}`,
  ]
    .filter(Boolean)
    .join('\n');
  return `${header}\n\n${m.transcriptMd}`;
}
