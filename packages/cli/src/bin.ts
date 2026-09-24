#!/usr/bin/env node
/** The executable of `@kadrion/cli`: `node packages/cli/dist/bin.js render-frames …`. */
import process from 'node:process';

import { runCli } from './cli.js';

process.exitCode = await runCli(process.argv.slice(2), {
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line) => {
    process.stderr.write(`${line}\n`);
  },
});
