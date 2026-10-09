import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureRefs, renderUseCase } from '../scripts/lib/fixtures.mjs';

const u = { request: 'Move {{fixture:t.Name}} to Done.', check: { rule: 'write_visible', expect: { SectionName: 'Done' },
  reference_sql: "SELECT [Id] FROM [Tasks] WHERE [Id] = '{{fixture:t.Id}}'",
  cleanup_procedure: { name: 'AddTaskToSection', parameters: { '@TaskId': '{{fixture:t.Id}}', '@SectionId': '{{fixture:s.Id}}' } } } };

test('a cleanup procedure names its records through fixtures, and they are filled at plan time', () => {
  assert.deepEqual([...fixtureRefs(u)].sort(), ['s', 't']);
  const r = renderUseCase(u, { t: { Id: '111', Name: "Fix O'Brien link" }, s: { Id: '222' } });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.check.cleanup_procedure, { name: 'AddTaskToSection', parameters: { '@TaskId': '111', '@SectionId': '222' } });
  assert.equal(u.check.cleanup_procedure.parameters['@TaskId'], '{{fixture:t.Id}}', 'the catalog itself is never changed');
});

test('an unbound fixture in a cleanup procedure holds the use case like any other', () => {
  const r = renderUseCase(u, { t: { Id: '111', Name: 'x' } });
  assert.deepEqual(r.missing, ['s.Id']);
});
