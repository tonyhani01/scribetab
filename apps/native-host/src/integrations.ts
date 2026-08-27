import type { MeetingSession, TranscriptSegment } from '@scribetab/shared';
import { loadConfig } from './config.js';
import { copyToObsidian } from './obsidian.js';
import { createNotionPage } from './notion.js';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Best-effort post-commit integrations. Never throws — callers attach
 * messages to HostSyncAck.error without failing the meetings-dir write.
 */
export async function runPostSyncIntegrations(opts: {
  session: MeetingSession;
  segments: TranscriptSegment[];
  summaryMarkdown?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const errors: string[] = [];
  let cfg;
  try {
    cfg = await loadConfig(opts.env, opts.platform);
  } catch (e) {
    return [`Integrations config: ${errMsg(e)}`];
  }

  if (cfg.obsidianEnabled) {
    const vault = cfg.obsidianVaultPath?.trim();
    if (!vault) {
      errors.push('Obsidian enabled but obsidianVaultPath is not set');
    } else {
      try {
        await copyToObsidian({
          vaultPath: vault,
          session: opts.session,
          segments: opts.segments,
          summaryMarkdown: opts.summaryMarkdown,
        });
      } catch (e) {
        errors.push(`Obsidian: ${errMsg(e)}`);
      }
    }
  }

  if (cfg.notionEnabled) {
    try {
      await createNotionPage({
        token: cfg.notion?.token || '',
        parentPageId: cfg.notion?.parentPageId || '',
        session: opts.session,
        segments: opts.segments,
        summaryMarkdown: opts.summaryMarkdown,
        fetchImpl: opts.fetchImpl,
      });
    } catch (e) {
      errors.push(`Notion: ${errMsg(e)}`);
    }
  }

  return errors;
}
