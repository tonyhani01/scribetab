#!/usr/bin/env node
import { runHostCli } from './cli.js';

runHostCli(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
