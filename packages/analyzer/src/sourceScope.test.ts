import { strict as assert } from 'node:assert';
import test from 'node:test';
import { classifySourceScope } from './sourceScope.js';

test('classifySourceScope separates production, tests, migrations, scripts, generated, and unknown', () => {
  assert.equal(classifySourceScope('app/lib/integrations/base-adapter.ts'), 'production');
  assert.equal(classifySourceScope('edge/functions/ingest.ts'), 'production');
  assert.equal(classifySourceScope('batchcortex-edge/src/handler.ts'), 'production');

  assert.equal(classifySourceScope('tests/rls/phase-2-isolation.test.ts'), 'test');
  assert.equal(classifySourceScope('app/lib/foo.spec.tsx'), 'test');
  assert.equal(classifySourceScope('src/__tests__/foo.ts'), 'test');

  assert.equal(classifySourceScope('supabase/migrations/20260525000000_init.sql'), 'migration');
  assert.equal(classifySourceScope('scripts/verify-reach.mts'), 'script');
  assert.equal(classifySourceScope('app/lib/database.types.ts'), 'generated');

  assert.equal(classifySourceScope('vendor/opaque.ts'), 'unknown');
});
