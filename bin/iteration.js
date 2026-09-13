#!/usr/bin/env node
/* eslint-disable */
// Entry point: transforms and loads the TypeScript CLI via the tsx require hook.
require('tsx/cjs');
require(require('path').join(__dirname, '..', 'src', 'cli.ts'));
