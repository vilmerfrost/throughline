# Throughline Diagnosis Overhaul Audit

Date: 2026-05-25
Branch: main

## Pre-Implementation Report

### Goal

Improve Throughline's diagnosis layer so it is as honest and useful as the verification loop. The overhaul targets five product gaps found in real run history:

1. SQL views are currently invisible to column reach, making TS-only `never_read` / `server_only` signals too easy to overread.
2. Root-cause cards imply factory fixes clear all downstream issues, even when explicit casts or bypasses remain at usage sites.
3. Reach copy needs louder scanned-scope language.
4. Root-cause progress should foreground touch/leverage deltas rather than a sticky aggregate count.
5. Drift documentation should say loose TypeScript clients can hide wrong-column reads until the client is typed.

### Planned Code Areas

- `packages/core/src/types.ts`
  - Add optional, additive model fields for SQL view read evidence and prior-run deltas.
- `packages/analyzer/src/sql/parseSql.ts`
  - Extract grounded SQL view read facts from migration `CREATE VIEW` statements.
- `packages/analyzer/src/ts/columnUsage.ts` and `packages/analyzer/src/ts/reach.ts`
  - Merge SQL view read facts into column usage and reach without weakening certainty rules.
- `packages/analyzer/src/buildGraph.ts`
  - Wire SQL view reads into column usage.
- `packages/analyzer/src/sql/parseSql.test.ts` and TS column/reach tests
  - Add red/green coverage for view reads and opaque fallback behavior.
- `apps/web/src/lib/columnUsage.ts`, `apps/web/src/components/ColumnUsageList.tsx`
  - Update reach language and caveats.
- `apps/web/src/lib/rootCauses.ts`, `apps/web/src/components/RootCauseCard.tsx`, `apps/web/src/components/RootCausesView.tsx`
  - Make root-cause guidance reason-specific and expose blocking usage sites.
- `apps/web/src/App.tsx`
  - Add client-side previous-run delta tracking/reporting if feasible without persistence surprises.
- `CLAUDE.md`
  - Update project memory so future agents understand SQL view reach evidence and loose-client drift limits.

### Verification Plan

- Red/green focused analyzer tests for SQL view extraction and column usage/reach integration.
- `pnpm --filter @throughline/analyzer test`
- `pnpm typecheck`
- If feasible, a real-repo verification script or extension of an existing reach verification report for SQL view evidence.

### Coordination Notes

The repository already had unrelated uncommitted frontend/analyzer changes before this work began. This implementation will not revert those changes. Any edits to already-dirty files will be narrow and compatible with the current file contents.

## Post-Implementation Report

### Implemented

1. SQL view read extraction
   - Added `SqlViewRead` / `SqlViewReadConfidence` and optional `Graph.sqlViewReads` in `packages/core/src/types.ts`.
   - Extended `parseSchema` in `packages/analyzer/src/sql/parseSql.ts` to return `sqlViewReads`.
   - Extracts `CREATE VIEW` / `CREATE OR REPLACE VIEW` reads from migration SQL.
   - Emits `certain` evidence for attributable base-table columns from projections, `table.*`, single-table `*`, join predicates, and where predicates.
   - Emits `opaque` evidence for non-simple query shapes such as CTEs where the view reads a known base table but exact output columns cannot be honestly attributed.
   - Wires the facts through `packages/analyzer/src/buildGraph.ts`.

2. Column usage and reach integration
   - `computeColumnUsage` now accepts SQL view reads.
   - Certain SQL view column reads become `used` with certain DB-side evidence.
   - Certain SQL view reads set reach to `server_only`, because a DB view proves a server-side read but not UI display.
   - Opaque SQL view table reads make affected columns `unknown` and carry the view `SourceRef`, preventing false `never_read` claims.

3. Verification reporting
   - Extended `packages/analyzer/scripts/verify-reach.mts` to call `parseSchema`, pass `sqlViewReads`, and report discovered SQL view read evidence.

4. Root-cause UX honesty
   - `apps/web/src/lib/rootCauses.ts` now separates blocking usage sites for `ts-cast-concrete`, `ts-cast-any`, and `ts-bypass-any`.
   - Fix prompts for cast/bypass root causes now target usage sites rather than the upstream construction site.
   - `apps/web/src/components/RootCauseCard.tsx` now gives reason-specific guidance and explicitly warns when factory fixes cannot clear downstream casts/bypasses.

5. Progress deltas
   - `apps/web/src/App.tsx` retains the previous graph after refresh.
   - `apps/web/src/components/RootCausesView.tsx` shows touches cleared and root causes removed since the last refresh, including reduced `affectedCount` for surviving root-cause groups.

6. Reach UI copy
   - `apps/web/src/lib/columnUsage.ts` and `apps/web/src/components/ColumnUsageList.tsx` now use scanned-scope language:
     - `server_only` -> "used outside scanned UI"
     - `never_read` -> "no scanned reader found"
     - `unknown` -> "reader exists · path opaque"
   - The column panel now states the scan scope: TypeScript UI plus migration-defined SQL views; Python/Rust/raw SQL/external agents remain outside column-level reach.

7. Project memory
   - Updated `CLAUDE.md` with SQL view reader behavior, new graph field, reach scope caveats, and the loose-client drift limitation.

### Tests Added

- `packages/analyzer/src/sql/parseSql.test.ts`
  - Grounded SQL view column reads.
  - Single-table `SELECT *` expansion.
   - Aliased single-table `SELECT *` expansion.
  - Join predicate reads.
   - Mixed multi-table `SELECT *` plus certain reads preserves opaque table coverage.
  - Where predicate reads.
  - Opaque CTE fallback.
- `packages/analyzer/src/ts/columnUsage.test.ts`
  - SQL view column read becomes certain `used` evidence.
  - Opaque SQL view table read turns otherwise unread columns `unknown`.
- `packages/analyzer/src/ts/reach.test.ts`
  - SQL view column read changes otherwise unread columns to `server_only`.
  - Opaque SQL view table read prevents `never_read`.

### Verification Evidence

- Focused red run before implementation failed 7 tests in the new SQL view/reach/usage cases.
- Focused analyzer tests after implementation passed: 32/32.
- Code review found and fixed one blocking SQL-view honesty issue: mixed ambiguous
  `SELECT *` plus certain predicate/projection evidence could drop opaque coverage
  for the same table. Added a regression and preserved opaque coverage alongside
  certain column evidence.
- Full analyzer suite passed after final predicate/alias/mixed-opaque support: 108/108.
- Full repository typecheck passed:
  - `pnpm typecheck`
- Production build passed:
  - `pnpm build`
  - Vite emitted a chunk-size warning for a 501.35 kB JS bundle, but build exited successfully.
- Real-repo verification passed:
  - `pnpm --filter @throughline/analyzer exec tsx scripts/verify-reach.mts`
  - Reported `/Users/vilmerfrost/Projects/Batch-Guard.ai-2`
  - 41 contracts
  - 3 SQL view read facts
  - Codebase reach tally: `ui_shown=63 server_only=133 never_read=98 unknown=344`
  - SQL view evidence included `v_batch_material_trace` reads over `material_lots`, `batches`, and `batch_material_usage`
  - Honesty checks passed:
    - every `unknown` carries an escape trail
    - no non-`unknown` reach carries an escape trail
    - no `never_read` survives an escaping/untyped `*` read
    - all four reach values are present

### Known Limits

- SQL view parsing intentionally handles simple `SELECT` views deeply and treats CTE/subquery/ambiguous cases as opaque table reads.
- SQL view evidence proves DB-side consumption, not UI display.
- Python, Rust, raw SQL outside migrations, and external agents remain outside column-level reach unless separately analyzed.
- TypeScript wrong-column drift can remain hidden behind loose clients or usage-site casts until the client and usages carry schema types.

### Files Most Relevant For Audit

- `packages/core/src/types.ts`
- `packages/analyzer/src/sql/parseSql.ts`
- `packages/analyzer/src/sql/parseSql.test.ts`
- `packages/analyzer/src/ts/columnUsage.ts`
- `packages/analyzer/src/ts/columnUsage.test.ts`
- `packages/analyzer/src/ts/reach.ts`
- `packages/analyzer/src/ts/reach.test.ts`
- `packages/analyzer/src/buildGraph.ts`
- `packages/analyzer/scripts/verify-reach.mts`
- `apps/web/src/lib/columnUsage.ts`
- `apps/web/src/components/ColumnUsageList.tsx`
- `apps/web/src/lib/rootCauses.ts`
- `apps/web/src/components/RootCauseCard.tsx`
- `apps/web/src/components/RootCausesView.tsx`
- `apps/web/src/App.tsx`
- `CLAUDE.md`


