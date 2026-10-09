/* 3.7 — bulk exports are reported as their own pattern, and a hard or ambiguous request with a single
 * wording is flagged: one attempt on one phrasing is close to a coin toss. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patternOf } from '../scripts/lib/report-data.mjs';
import { validateCatalog } from '../scripts/lib/catalog.mjs';

test('an export-style request is a bulk read, not a conversation', () => {
  assert.equal(patternOf({ tests: ['aggregation'], request: 'Pull every time entry for our billing export.' }), 'bulk_read');
  assert.equal(patternOf({ tests: ['aggregation'], request: 'How many hours did the team log last week?' }), 'aggregate');
  assert.equal(patternOf({ tests: ['limitation'], request: 'Export all budgets every night.' }), 'limitation', 'a limitation still reads as one');
});

test('a complex or ambiguous request with one wording gets a warning, never a refusal', () => {
  const u = (id, extra) => ({ id, area: 'TM', persona: 'P', goal: 'g', kind: 'question', status: 'approved', capabilities: [], source: { kind: 'community', title: 't', url: 'https://x' },
    request: `Which projects slipped the most this quarter, and why ${id}?`, expected_behavior: ['answers'], check: { rule: 'judge' }, ...extra });
  const v = validateCatalog({ use_cases: [u('UC-1', { difficulty: 'complex', tests: ['aggregation'] }), u('UC-2', { difficulty: 'complex', tests: ['aggregation'], variants: ['Which projects fell furthest behind this quarter?'] })] });
  assert.ok(v.warnings.some(w => /UC-1: a complex request with one wording/.test(w)));
  assert.ok(!v.warnings.some(w => /UC-2: a complex request/.test(w)));
  assert.ok(!v.problems.some(p => /one wording/.test(p)));
});
