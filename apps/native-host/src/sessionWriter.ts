import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { wavHeader, type MeetingSession, type TranscriptSegment } from '@scribetab/shared';
import { MAX_AUDIO_CHUNK_BYTES } from './constants.js';
import { formatTranscriptJson, formatTranscriptMarkdown } from './exportFiles.js';
import { meetingDirBase, uniqueMeetingDir } from './slug.js';

export interface AudioMeta {
  format: 'wav';
  sampleRate: number;
  totalChunks: number;
}

export interface InFlightSync {
  sessionId: string;
  session: MeetingSession;
  segments: TranscriptSegment[];
  summaryMarkdown?: string;
  audio?: AudioMeta;
  tmpDir: string;
  pcmPath: string;
  received: number;
}

function pcmFromDecoded(buf: Buffer): Buffer {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF') {
    if (buf.length < 44) throw new Error('Truncated WAV chunk');
    return buf.subarray(44);
  }
  return buf;
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
  return {
    sessionId: session.id,
    session,
    segments,
    summaryMarkdown: opts.summaryMarkdown,
    audio: opts.audio,
    tmpDir,
    pcmPath: join(tmpDir, 'audio.pcm'),
    received: 0,
  };
}

export async function appendAudioChunk(sync: InFlightSync, index: number, wavBase64: string): Promise<void> {
  if (!sync.audio) throw new Error('Audio chunk received but sync_begin had no audio metadata');
  if (index !== sync.received) {
    throw new Error(`Unexpected audio chunk index ${index}, expected ${sync.received}`);
  }
  if (index < 0 || index >= sync.audio.totalChunks) {
    throw new Error(`Audio chunk index ${index} out of range (totalChunks=${sync.audio.totalChunks})`);
  }
  const decoded = Buffer.from(wavBase64, 'base64');
  if (decoded.length > MAX_AUDIO_CHUNK_BYTES) {
    throw new Error(`Audio chunk ${index} exceeds 8 MiB (${decoded.length} bytes)`);
  }
  await appendFile(sync.pcmPath, pcmFromDecoded(decoded));
  sync.received += 1;
}

export async function abortSync(sync: InFlightSync | null): Promise<void> {
  if (!sync) return;
  await rm(sync.tmpDir, { recursive: true, force: true });
}

export async function commitSync(sync: InFlightSync, meetingsRoot: string): Promise<string> {
  if (sync.audio && sync.received !== sync.audio.totalChunks) {
    throw new Error(`Expected ${sync.audio.totalChunks} audio chunks, received ${sync.received}`);
  }

  const md = formatTranscriptMarkdown(sync.session, sync.segments);
  const json = formatTranscriptJson(sync.session, sync.segments);
  await writeFile(join(sync.tmpDir, 'transcript.md'), md, 'utf8');
  await writeFile(join(sync.tmpDir, 'transcript.json'), json, 'utf8');
  if (sync.summaryMarkdown) {
    await writeFile(join(sync.tmpDir, 'summary.md'), sync.summaryMarkdown, 'utf8');
  }

  if (sync.audio && sync.audio.totalChunks > 0) {
    const pcm = await readFile(sync.pcmPath);
    const header = Buffer.from(wavHeader(pcm.byteLength, sync.audio.sampleRate));
    await writeFile(join(sync.tmpDir, 'audio.wav'), Buffer.concat([header, pcm]));
    await rm(sync.pcmPath, { force: true });
  } else {
    await rm(sync.pcmPath, { force: true });
  }

  const base = meetingDirBase(sync.session.startedAt, sync.session.title);
  const dest = uniqueMeetingDir(meetingsRoot, base);
  await rename(sync.tmpDir, dest);
  return dest;
}
