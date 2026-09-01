import { join } from 'node:path';
import type { MeetingSession, TranscriptSegment } from '@scribetab/shared';
import { atomicWriteFile } from './atomicWrite.js';
import { obsidianSubfolderFor } from './automations.js';
import { loadConfig } from './config.js';
import { copyToObsidian } from './obsidian.js';
import { createNotionPage, NOTION_INTEGRATION_BUDGET_MS } from './notion.js';

export const INTEGRATION_ERROR_MAX = 200;

export type IntegrationStatus = {
  ok: boolean;
  message?: string;
  pageId?: string;
  path?: string;
};

export type IntegrationStatuses = {
  obsidian?: IntegrationStatus;
  notion?: IntegrationStatus;
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function sanitizeIntegrationError(message: string, token?: string): string {
  let s = message.replace(/\r?\n+/g, ' ');
  if (token && token.length > 0 && s.includes(token)) {
    s = s.split(token).join('[token]');
  }
  if (s.length > INTEGRATION_ERROR_MAX) s = s.slice(0, INTEGRATION_ERROR_MAX);
  return s;
}

export async function writeMeetingIntegrationStatus(
  meetingDir: string,
  statuses: IntegrationStatuses,
): Promise<void> {
  await atomicWriteFile(join(meetingDir, 'integrations.json'), JSON.stringify(statuses, null, 2) + '\n');
}

function followUpError(statuses: IntegrationStatuses): string | undefined {
  const parts: string[] = [];
  if (statuses.obsidian && !statuses.obsidian.ok && statuses.obsidian.message) {
    parts.push(`Obsidian: ${statuses.obsidian.message}`);
  }
  if (statuses.notion && !statuses.notion.ok && statuses.notion.message) {
    parts.push(`Notion: ${statuses.notion.message}`);
  }
  return parts.length ? parts.join('; ') : undefined;
}

/**
 * Best-effort post-commit integrations. Never throws — callers record
 * per-integration status next to the meeting without failing the ack.
 */
export async function runPostSyncIntegrations(opts: {
  session: MeetingSession;
  segments: TranscriptSegment[];
  summaryMarkdown?: string;
  meetingDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
}): Promise<IntegrationStatuses> {
  const statuses: IntegrationStatuses = {};
  let cfg;
  try {
    cfg = await loadConfig(opts.env, opts.platform);
  } catch (e) {
    const message = sanitizeIntegrationError(`Integrations config: ${errMsg(e)}`);
    statuses.obsidian = { ok: false, message };
    return statuses;
  }

  const token = cfg.notion?.token;

  if (cfg.obsidianEnabled) {
    const vault = cfg.obsidianVaultPath?.trim();
    if (!vault) {
      statuses.obsidian = {
        ok: false,
        message: sanitizeIntegrationError('Obsidian enabled but obsidianVaultPath is not set', token),
      };
    } else {
      try {
        // Automations only route what the enabled integration already writes:
        // no rules, or no matching Obsidian rule ⇒ vault root, unchanged.
        const subfolder = obsidianSubfolderFor(cfg.automations ?? [], opts.session.title);
        const path = await copyToObsidian({
          vaultPath: vault,
          session: opts.session,
          segments: opts.segments,
          summaryMarkdown: opts.summaryMarkdown,
          subfolder,
        });
        statuses.obsidian = {
          ok: true,
          path,
          message: subfolder ? `routed to ScribeTab/${subfolder}` : undefined,
        };
      } catch (e) {
        statuses.obsidian = { ok: false, message: sanitizeIntegrationError(errMsg(e), token) };
      }
    }
  }

  if (cfg.notionEnabled) {
    try {
      const result = await createNotionPage({
        token: cfg.notion?.token || '',
        parentPageId: cfg.notion?.parentPageId || '',
        session: opts.session,
        segments: opts.segments,
        summaryMarkdown: opts.summaryMarkdown,
        fetchImpl: opts.fetchImpl,
        env: opts.env,
        platform: opts.platform,
        deadline: Date.now() + NOTION_INTEGRATION_BUDGET_MS,
      });
      statuses.notion = { ok: true, pageId: result.pageId, message: result.skipped ? 'already synced' : undefined };
    } catch (e) {
      statuses.notion = { ok: false, message: sanitizeIntegrationError(errMsg(e), token) };
    }
  }

  if (opts.meetingDir) {
    try {
      await writeMeetingIntegrationStatus(opts.meetingDir, statuses);
    } catch (e) {
      const message = sanitizeIntegrationError(`status file: ${errMsg(e)}`, token);
      if (!followUpError(statuses)) {
        statuses.obsidian = statuses.obsidian ?? { ok: false, message };
      }
    }
  }

  return statuses;
}

export function integrationFollowUpError(statuses: IntegrationStatuses): string | undefined {
  return followUpError(statuses);
}
