import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadRuntimeEnv } from '../../../src/env.ts';

// This branch is the contest edition. Setting 0 restores the existing member UI.
export function contestSettings(env = process.env, now = Date.now()) {
  if (env === process.env) loadRuntimeEnv(resolve(process.env.PROOFOLIO_ROOT ?? (existsSync('src/cli.ts') ? '.' : '..')));
  const enabled = env.PROOFOLIO_CONTEST_MODE !== '0';
  const endText = env.PROOFOLIO_CONTEST_ENDS_AT || '2026-10-20T23:59:59+09:00';
  const end = /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(endText) ? Date.parse(endText) : NaN;
  const closed = env.PROOFOLIO_CONTEST_CLOSED === '1' || Number.isNaN(end) || end <= now;
  return { enabled, closed, expiresAt: new Date(Math.min(now + 86400000, Number.isFinite(end) ? end : now + 86400000)).toISOString() };
}
