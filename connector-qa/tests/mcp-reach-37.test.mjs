/* 3.7 — what ConnectAI MCP can actually run. Its tools accept SELECT, INSERT, UPDATE and procedures,
 * never DELETE, so a capability "supported" by a driver DELETE is not supported through MCP (Asana:
 * 15 delete and remove capabilities), and a created record can be removed only by a delete procedure. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceMcpReach, cleanupPathFor } from '../scripts/lib/capabilities.mjs';
import { validateCatalog } from '../scripts/lib/catalog.mjs';

const cap = (id, method, path, exposure, status = 'exposed') => ({ id, method, path, mapping: { status, exposure, confidence: 'reviewed' } });

test('a driver DELETE is not supported through ConnectAI MCP; a delete procedure is', () => {
  const caps = [
    cap('del-task', 'DELETE', '/tasks/{gid}', [{ kind: 'table', name: 'Tasks', op: 'DELETE' }]),
    cap('del-proj', 'DELETE', '/projects/{gid}', [{ kind: 'procedure', name: 'DeleteProject' }]),
    cap('rm-member', 'POST', '/projects/{gid}/removeMembers', [{ kind: 'table', name: 'ProjectMembers', op: 'DELETE' }, { kind: 'procedure', name: 'RemoveMembers' }]),
    cap('get-task', 'GET', '/tasks/{gid}', [{ kind: 'table', name: 'Tasks', op: 'SELECT' }]),
  ];
  const changed = enforceMcpReach(caps);
  assert.deepEqual(changed, ['del-task', 'rm-member']);
  assert.equal(caps[0].mapping.status, 'not_exposed');
  assert.match(caps[0].mapping.note, /supports DELETE on Tasks, but ConnectAI MCP has no tool that runs DELETE/);
  assert.equal(caps[1].mapping.status, 'exposed', 'a procedure is reachable');
  assert.equal(caps[2].mapping.status, 'partly', 'the procedure still does part of it');
  assert.deepEqual(enforceMcpReach(caps), [], 'applied once');
  /* a server that gains a delete tool is one config line */
  const later = [cap('d', 'DELETE', '/x/{id}', [{ kind: 'table', name: 'X', op: 'DELETE' }])];
  assert.deepEqual(enforceMcpReach(later, ['SELECT', 'INSERT', 'UPDATE', 'DELETE']), []);
});

test('a created record can be cleaned up only where a delete procedure exists', () => {
  const caps = [
    cap('new-task', 'POST', '/tasks', [{ kind: 'table', name: 'Tasks', op: 'INSERT' }]),
    cap('del-task', 'DELETE', '/tasks/{gid}', [{ kind: 'procedure', name: 'DeleteTask' }]),
    cap('new-goal', 'POST', '/goals', [{ kind: 'table', name: 'Goals', op: 'INSERT' }]),
    cap('del-goal', 'DELETE', '/goals/{gid}', [], 'not_exposed'),
  ];
  assert.deepEqual(cleanupPathFor(caps[0], caps), { capability: 'del-task', procedure: 'DeleteTask' });
  assert.equal(cleanupPathFor(caps[2], caps), null);
  const base = { area: 'TM', persona: 'Lead', goal: 'g', status: 'approved', source: { kind: 'community', title: 't', url: 'https://x' }, difficulty: 'simple', tests: ['write'], expected_behavior: ['creates it'] };
  const v = validateCatalog({ use_cases: [
    { ...base, id: 'UC-1', kind: 'action', request: 'Add a task to send the launch checklist.', capabilities: ['new-task'],
      check: { rule: 'write_visible', expect: { Name: 'x' }, reference_sql: 'SELECT [Id] FROM [Tasks]' } },
    { ...base, id: 'UC-2', kind: 'action', request: 'Add a task to book the venue.', capabilities: ['new-task'],
      check: { rule: 'write_visible', expect: { Name: 'y' }, reference_sql: 'SELECT [Id] FROM [Tasks]', cleanup_sql: "DELETE FROM [Tasks] WHERE [Name] = 'y'" } },
    { ...base, id: 'UC-3', kind: 'job', writes: true, request: 'Move every overdue task to next week.', capabilities: ['new-task'],
      check: { rule: 'judge', cleanup_procedure: { name: 'DeleteTask', parameters: { '@Id': '{{located}}' } } } },
  ] }, { capabilities: caps });
  assert.ok(v.warnings.some(w => /UC-1: what it creates can be removed with the procedure DeleteTask/.test(w)));
  assert.ok(v.warnings.some(w => /UC-2: cleanup_sql is a DELETE, which ConnectAI MCP cannot run/.test(w)));
  assert.ok(v.problems.some(p => /UC-3: cleanup_procedure uses \{\{located\}\} but there is no locate_sql/.test(p)));
  assert.ok(v.warnings.some(w => /UC-3: a job that writes should give check.scope_sql/.test(w)));
});
