import type { EdgeDirection, SourceScope, WriterLifecycle } from '@throughline/core';

// Classify a WRITE touch's lifecycle from its source location. Reads have no
// lifecycle — we never claim "this is a migration read". The classifier is a
// pure path-based function: it never inspects code semantics, only WHERE the
// write lives.
//
// migration → file lives under supabase/migrations or has been pre-classified
//             as a migration scope (e.g. SQL `INSERT INTO` in a migration).
// seed      → script files whose name signals data loading (seed*, fixture*,
//             populate*) or any script in supabase/seed*.
// trigger   → the caller explicitly marks the write as DB-driven (a SQL
//             trigger function body). The path classifier cannot detect this
//             on its own.
// runtime   → everything else: the default actor for app code.
export function classifyWriterLifecycle(
  filePath: string | undefined,
  direction: EdgeDirection,
  sourceScope?: SourceScope,
): WriterLifecycle | undefined {
  if (direction !== 'write') return undefined;
  if (sourceScope === 'migration') return 'migration';
  if (!filePath) return 'runtime';
  const normalized = filePath.split(/[\\/]/).join('/');
  if (normalized.startsWith('supabase/migrations/')) return 'migration';
  if (/^supabase\/seed/.test(normalized)) return 'seed';
  const base = normalized.split('/').at(-1)?.toLowerCase() ?? '';
  if (sourceScope === 'script' && /(?:^|[_\-/.])(seed|fixture|populate|bootstrap|backfill)s?[_\-./]/.test(`/${base}`)) {
    return 'seed';
  }
  return 'runtime';
}
