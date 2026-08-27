#!/usr/bin/env node
import { isEpipe } from './framing.js';
import { runHostCli } from './cli.js';

runHostCli(process.argv.slice(2)).catch((e) => {
  if (isEpipe(e)) process.exit(0);
  process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
