import { appendFile, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  exportJson,
  exportMarkdown,
  wavHeader,
  type HostSyncAudio,
  type MeetingSession,
  type TranscriptSegment,
} from '@scribetab/shared';
import { MAX_AUDIO_CHUNK_BYTES } from './constants.js';
import { meetingDirBase, uniqueMeetingDir } from './slug.js';

export type AudioMeta = HostSyncAudio;

export interface InFlightSync {
  sessionId: string;
  session: MeetingSession;
  segments: TranscriptSegment[];
  summaryMarkdown?: string;
  audio?: AudioMeta;
  tmpDir: string;
  /** Destination file: audio.wav or audio.ogg. */
  audioPath: string;
  pcmBytes: number;
  received: number;
  audioSkipped?: string;
}

function pcmFromDecoded(buf: Buffer): Buffer {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF') {
    if (buf.length < 44) throw new Error('Truncated WAV chunk');
    return buf.subarray(44);
  }
  return buf;
}

export async function sweepOrphanTmpDirs(meetingsRoot: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(meetingsRoot);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return;
    throw e;
  }
  await Promise.all(
    names
      .filter((name) => name.startsWith('.tmp-'))
      .map((name) => rm(join(meetingsRoot, name), { recursive: true, force: true })),
  );
}

async function findDirBySessionId(root: string, sessionId: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return undefined;
    throw e;
  }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const dir = join(root, name);
    try {
      const st = await lstat(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
    } catch {
      continue;
    }
    let jsonText: string;
    try {
      jsonText = await readFile(join(dir, 'transcript.json'), 'utf8');
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(jsonText) as { session?: { id?: string } };
      if (parsed.session?.id === sessionId) return dir;
    } catch {
      // ignore unreadable json
    }
  }
  return undefined;
}

async function replaceDir(tmpDir: string, dest: string): Promise<void> {
  let destExists = false;
  try {
    await lstat(dest);
    destExists = true;
  } catch {
    destExists = false;
  }
  if (!destExists) {
    await rename(tmpDir, dest);
    return;
  }
  const bak = `${dest}.replacing-${randomUUID()}`;
  await rename(dest, bak);
  try {
    await rename(tmpDir, dest);
  } catch (e) {
    await rename(bak, dest).catch(() => {});
    throw e;
  }
  await rm(bak, { recursive: true, force: true });
}

export async function beginSync(
  meetingsRoot: string,
  session: MeetingSession,
  segments: TranscriptSegment[],
  opts: { summaryMarkdown?: string; audio?: AudioMeta } = {},
): Promise<InFlightSync> {
  await mkdir(meetingsRoot, { recursive: true });
  const tmpDir = join(meetingsRoot, `.tmp-${randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  const isOgg = opts.audio?.format === 'ogg-opus';
  const audioPath = join(tmpDir, isOgg ? 'audio.ogg' : 'audio.wav');
  if (opts.audio && opts.audio.totalChunks > 0 && opts.audio.format === 'wav') {
    await writeFile(audioPath, Buffer.from(wavHeader(0, opts.audio.sampleRate)));
  }
  return {
    sessionId: session.id,
    session,
    segments,
    summaryMarkdown: opts.summaryMarkdown,
    audio: opts.audio,
    tmpDir,
    audioPath,
    pcmBytes: 0,
    received: 0,
  };
}

export async function appendAudioChunk(sync: InFlightSync, index: number, payloadBase64: string): Promise<void> {
  if (sync.audioSkipped) return;
  if (!sync.audio) throw new Error('Audio chunk received but sync_begin had no audio metadata');
  if (index !== sync.received) {
    throw new Error(`Unexpected audio chunk index ${index}, expected ${sync.received}`);
  }
  if (index < 0 || index >= sync.audio.totalChunks) {
    throw new Error(`Audio chunk index ${index} out of range (totalChunks=${sync.audio.totalChunks})`);
  }

  const decoded = Buffer.from(payloadBase64, 'base64');
  if (decoded.length > MAX_AUDIO_CHUNK_BYTES) {
    sync.audioSkipped = `Audio chunk ${index} exceeds 8 MiB`;
    await rm(sync.audioPath, { force: true });
    return;
  }
  let bytes: Buffer;
  if (sync.audio.format === 'ogg-opus') {
    bytes = decoded;
  } else {
    try {
      bytes = pcmFromDecoded(decoded);
    } catch (e) {
      sync.audioSkipped = e instanceof Error ? e.message : String(e);
      await rm(sync.audioPath, { force: true });
      return;
    }
  }
  await appendFile(sync.audioPath, bytes);
  sync.pcmBytes += bytes.length;
  sync.received += 1;
}

export async function abortSync(sync: InFlightSync | null): Promise<void> {
  if (!sync) return;
  await rm(sync.tmpDir, { recursive: true, force: true });
}

export async function commitSync(sync: InFlightSync, meetingsRoot: string): Promise<string> {
  if (sync.audio && !sync.audioSkipped && sync.received !== sync.audio.totalChunks) {
    throw new Error(`Expected ${sync.audio.totalChunks} audio chunks, received ${sync.received}`);
  }

  const md = exportMarkdown(sync.session, sync.segments);
  const json = exportJson(sync.session, sync.segments);
  await writeFile(join(sync.tmpDir, 'transcript.md'), md, 'utf8');
  await writeFile(join(sync.tmpDir, 'transcript.json'), json, 'utf8');
  if (sync.summaryMarkdown) {
    await writeFile(join(sync.tmpDir, 'summary.md'), sync.summaryMarkdown, 'utf8');
  }

  if (sync.audio && !sync.audioSkipped && sync.audio.totalChunks > 0 && sync.pcmBytes > 0) {
    if (sync.audio.format === 'wav') {
      const fh = await open(sync.audioPath, 'r+');
      try {
        await fh.write(Buffer.from(wavHeader(sync.pcmBytes, sync.audio.sampleRate)), 0, 44, 0);
      } finally {
        await fh.close();
      }
    }
  } else {
    await rm(sync.audioPath, { force: true });
  }

  const existing = await findDirBySessionId(meetingsRoot, sync.sessionId);
  const dest = existing ?? uniqueMeetingDir(meetingsRoot, meetingDirBase(sync.session.startedAt, sync.session.title));
  await replaceDir(sync.tmpDir, dest);
  return dest;
}
