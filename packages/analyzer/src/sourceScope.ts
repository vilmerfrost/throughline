import path from 'node:path';
import type { SourceScope } from '@throughline/core';

const TEST_FILE = /\.(?:test|spec)\.[cm]?[tj]sx?$/;
const GENERATED_FILES = new Set(['app/lib/database.types.ts']);

export function classifySourceScope(filePath: string | undefined): SourceScope {
  if (!filePath) return 'unknown';
  const normalized = filePath.split(path.sep).join('/');
  const base = normalized.split('/').at(-1) ?? normalized;

  if (GENERATED_FILES.has(normalized) || /\.generated\.[cm]?[tj]sx?$/.test(base)) return 'generated';
  if (normalized.startsWith('supabase/migrations/')) return 'migration';
  if (normalized.startsWith('scripts/')) return 'script';
  if (
    normalized.startsWith('tests/') ||
    normalized.includes('/tests/') ||
    normalized.includes('/__tests__/') ||
    TEST_FILE.test(base)
  ) {
    return 'test';
  }
  if (
    normalized.startsWith('app/') ||
    normalized.startsWith('edge/') ||
    normalized.startsWith('batchcortex-edge/src/')
  ) {
    return 'production';
  }
  return 'unknown';
}
