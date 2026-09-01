import type { TranscriptSegment } from './types.js';

type ImportedSegment = Pick<TranscriptSegment, 'speaker' | 'text' | 'startMs' | 'endMs'>;

type ImportResult =
  | { title: string; segments: ImportedSegment[] }
  | { error: string };

const MAX_SEGMENTS = 20_000;

function normalizeLines(content: string): string {
  return content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function splitSpeakerPrefix(text: string): { speaker?: string; text: string } {
  const colon = text.indexOf(':');
  const firstLineEnd = text.indexOf('\n');
  if (colon <= 0 || colon > 100 || (firstLineEnd >= 0 && colon > firstLineEnd)) {
    return { text };
  }

  const speaker = text.slice(0, colon).trim();
  const remainder = text.slice(colon + 1).trim();
  if (!speaker || !remainder) return { text };
  return { speaker, text: remainder };
}

function segment(
  text: string,
  startMs: number,
  endMs: number,
  speaker?: string,
): ImportedSegment {
  return speaker ? { speaker, text, startMs, endMs } : { text, startMs, endMs };
}

function parseTimestamp(value: string, requireHours: boolean): number | undefined {
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(value);
  if (!match || (requireHours && match[1] === undefined)) return undefined;

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  if (minutes > 59 || seconds > 59) return undefined;

  const total = ((hours * 60 + minutes) * 60 + seconds) * 1_000 + milliseconds;
  return Number.isSafeInteger(total) ? total : undefined;
}

function decodeVttEntities(text: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    gt: '>',
    lt: '<',
    lrm: '\u200e',
    nbsp: '\u00a0',
    rlm: '\u200f',
  };
  return text.replace(/&(amp|gt|lt|lrm|nbsp|rlm);/g, (entity) => entities[entity.slice(1, -1)] ?? entity);
}

function parseVttCueText(rawText: string): { speaker?: string; text: string } {
  const voiceMatch = /<v(?:\.[^\s>]+)*(?:\s+([^>]+))?>/i.exec(rawText);
  const text = decodeVttEntities(rawText.replace(/<[^>\n]*>/g, '')).trim();
  const voiceSpeaker = voiceMatch?.[1]
    ? decodeVttEntities(voiceMatch[1]).trim()
    : undefined;
  if (voiceSpeaker) return { speaker: voiceSpeaker, text };
  return splitSpeakerPrefix(text);
}

function parseVtt(content: string): ImportedSegment[] | undefined {
  const normalized = normalizeLines(content);
  const newline = normalized.indexOf('\n');
  const header = (newline >= 0 ? normalized.slice(0, newline) : normalized).trimEnd();
  if (!/^WEBVTT(?:[ \t].*)?$/.test(header)) return undefined;

  const body = newline >= 0 ? normalized.slice(newline + 1).trim() : '';
  if (!body) return [];

  const segments: ImportedSegment[] = [];
  for (const block of body.split(/\n[ \t]*\n+/)) {
    if (segments.length >= MAX_SEGMENTS) break;

    const lines = block.split('\n');
    const firstLine = lines[0]?.trim() ?? '';
    if (/^(?:NOTE|STYLE|REGION)(?:[ \t]|$)/.test(firstLine)) continue;

    const timeLineIndex = lines.findIndex((line, index) => index <= 1 && line.includes('-->'));
    if (timeLineIndex < 0) continue;
    const timeLine = lines[timeLineIndex]?.trim();
    if (!timeLine) continue;

    const timeMatch = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(timeLine);
    const startValue = timeMatch?.[1];
    const endValue = timeMatch?.[2];
    if (!startValue || !endValue) continue;

    const startMs = parseTimestamp(startValue, false);
    const endMs = parseTimestamp(endValue, false);
    if (startMs === undefined || endMs === undefined || endMs <= startMs) continue;

    const cue = parseVttCueText(lines.slice(timeLineIndex + 1).join('\n'));
    if (!cue.text) continue;
    segments.push(segment(cue.text, startMs, endMs, cue.speaker));
  }

  return segments.length > 0 ? segments : undefined;
}

function parseSrt(content: string): ImportedSegment[] | undefined {
  const normalized = normalizeLines(content).trim();
  if (!normalized) return undefined;

  const segments: ImportedSegment[] = [];
  for (const block of normalized.split(/\n[ \t]*\n+/)) {
    if (segments.length >= MAX_SEGMENTS) break;

    const lines = block.split('\n');
    if (!/^\d+$/.test(lines[0]?.trim() ?? '')) continue;

    const timeLine = lines[1]?.trim();
    if (!timeLine) continue;
    const timeMatch = /^(\d+:\d{2}:\d{2},\d{3})\s+-->\s+(\d+:\d{2}:\d{2},\d{3})(?:\s+.*)?$/.exec(timeLine);
    const startValue = timeMatch?.[1];
    const endValue = timeMatch?.[2];
    if (!startValue || !endValue) continue;

    const startMs = parseTimestamp(startValue, true);
    const endMs = parseTimestamp(endValue, true);
    if (startMs === undefined || endMs === undefined || endMs <= startMs) continue;

    const cue = splitSpeakerPrefix(lines.slice(2).join('\n').trim());
    if (!cue.text) continue;
    segments.push(segment(cue.text, startMs, endMs, cue.speaker));
  }

  return segments.length > 0 ? segments : undefined;
}

function parseTxt(content: string): ImportedSegment[] | undefined {
  const normalized = normalizeLines(content).trim();
  if (!normalized) return undefined;

  const paragraphs = normalized.split(/\n[ \t]*\n+/).slice(0, MAX_SEGMENTS);
  return paragraphs.map((paragraph, index) => {
    const parsed = splitSpeakerPrefix(paragraph.trim());
    const startMs = index * 1_000;
    return segment(parsed.text, startMs, startMs + 1_000, parsed.speaker);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(content: string): ImportedSegment[] | undefined {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed) || !isRecord(parsed.session) || typeof parsed.session.title !== 'string') {
    return undefined;
  }
  if (!Array.isArray(parsed.segments)) return undefined;

  const segments: ImportedSegment[] = [];
  for (const value of parsed.segments.slice(0, MAX_SEGMENTS)) {
    if (
      !isRecord(value)
      || typeof value.text !== 'string'
      || typeof value.startMs !== 'number'
      || !Number.isFinite(value.startMs)
      || value.startMs < 0
      || typeof value.endMs !== 'number'
      || !Number.isFinite(value.endMs)
      || value.endMs < value.startMs
      || (value.speaker !== undefined && typeof value.speaker !== 'string')
    ) {
      return undefined;
    }
    segments.push(segment(value.text, value.startMs, value.endMs, value.speaker));
  }
  return segments;
}

export function parseTranscriptFile(name: string, content: string): ImportResult {
  try {
    const extensionMatch = /\.([^.]+)$/.exec(name);
    const extension = extensionMatch?.[1]?.toLowerCase();
    if (!extensionMatch || !extension) return { error: 'Unsupported transcript file type' };

    const title = name.slice(0, extensionMatch.index);
    let segments: ImportedSegment[] | undefined;
    if (extension === 'vtt') segments = parseVtt(content);
    else if (extension === 'srt') segments = parseSrt(content);
    else if (extension === 'txt') segments = parseTxt(content);
    else if (extension === 'json') segments = parseJson(content);
    else return { error: `Unsupported transcript file type: .${extension}` };

    if (!segments) return { error: `Could not parse ${extension.toUpperCase()} transcript` };
    return { title, segments };
  } catch {
    return { error: 'Could not parse transcript file' };
  }
}
