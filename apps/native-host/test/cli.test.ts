import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { HOST_JS, HOST_LEGACY_JS, MCP_JS } from './helpers.js';

const execFileAsync = promisify(execFile);

describe('CLI --help', () => {
  it('runs under plain Node', async () => {
    const { stdout } = await execFileAsync(process.execPath, [HOST_JS, '--help']);
    expect(stdout).toMatch(/scribetab-host/);
    expect(stdout).toMatch(/install/);
  });

  it('mcp --help runs under plain Node', async () => {
    const { stdout } = await execFileAsync(process.execPath, [MCP_JS, '--help']);
    expect(stdout).toMatch(/scribetab-mcp/);
    expect(stdout).toMatch(/list_transcripts/);
  });

  it('bin entrypoints start', async () => {
    const host = await execFileAsync(process.execPath, [HOST_JS, '--help']);
    expect(host.stdout).toMatch(/scribetab-host/);
    const mcp = await execFileAsync(process.execPath, [MCP_JS, '--help']);
    expect(mcp.stdout).toMatch(/scribetab-mcp/);
    const legacy = await execFileAsync(process.execPath, [HOST_LEGACY_JS, '--help']);
    expect(legacy.stdout).toMatch(/scribetab-host/);
  });
});
