/** Pad a non-negative integer to at least `width` digits. */
function pad(n: number, width: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(width, '0');
}

/** Split session-relative milliseconds into h/m/s/ms parts. */
export function splitMs(totalMs: number): { h: number; m: number; s: number; ms: number } {
  const clamped = Math.max(0, Math.floor(totalMs));
  const ms = clamped % 1000;
  const totalSec = Math.floor(clamped / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return { h, m, s, ms };
}

/** `HH:MM:SS,mmm` (SRT). */
export function formatSrtTime(totalMs: number): string {
  const { h, m, s, ms } = splitMs(totalMs);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

/** `HH:MM:SS.mmm` (WebVTT). */
export function formatVttTime(totalMs: number): string {
  const { h, m, s, ms } = splitMs(totalMs);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

/** `HH:MM:SS` for markdown body timestamps. */
export function formatClock(totalMs: number): string {
  const { h, m, s } = splitMs(totalMs);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}`;
}
