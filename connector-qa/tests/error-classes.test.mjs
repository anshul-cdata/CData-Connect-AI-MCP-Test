/* Error classification for driver failures seen in the Asana run (asn007 / asn-eval1). Each was
 * "unclassified · unknown" before, which left the Failed queries tab and the friction counts blind. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../scripts/lib/journey.mjs';

const cases = [
  ["The connector's server isn't responding. You can try again.", 'server_unavailable', 'connector'],
  ['STMT HTTP [40002] Dependencies are not available for this task.', 'plan_limit', 'account'],
  ['STMT HTTP [40002] User cannot access goals without premium permissions', 'plan_limit', 'account'],
  ['STMT HTTP [40002] Custom Field Settings are not available for free users', 'plan_limit', 'account'],
  ['STMT DATA_SOURCE [60002] Column Id or [OwnerId and WorkspaceId] is required to retrieve the results from Portfolios', 'required_filter', 'instructions'],
  ['STMT HTTP [40002] You should specify one of team, user + workspace.', 'required_filter', 'instructions'],
  ['STMT HTTP [40002] Must specify exactly one of project, tag, section, user task list, or assignee + workspace.', 'required_filter', 'instructions'],
  ["STMT STMT Unable to perform 'UPDATE' operation on 'Teams' table.", 'unsupported_operation', 'connector'],
  ['STMT DATA_SOURCE [60004] The column [Followers] could not be updated.', 'unsupported_operation', 'connector'],
  ['Error: result (93,354 characters) exceeds maximum allowed tokens. Output has been saved to a file.', 'result_too_large', 'ai'],
  ['[ACTION REQUIRED-Authenticate this connection]: https://cloud.cdata.com/connections/edit', 'auth_required', 'account'],
  ['STMT CORE Unrecognized column [Text] in query for table [Projects]', 'column_not_found', 'ai'],
  ['Permission for this action was denied by the Claude Code auto mode classifier.', 'harness_blocked', 'harness'],
  ['HTTP 429 Too Many Requests', 'rate_limit', 'connector'],
];
for (const [text, cls, cause] of cases) {
  test(`classifies: ${text.slice(0, 60)}`, () => assert.deepEqual(classifyError(text), { class: cls, cause }));
}

/* 3.3.2: instructions vs metadata vs the agent. What the usage instructions should have said is the
 * instructions'; a name the connector itself listed and then rejected is the metadata's; a name it
 * never listed is the agent's guess. */
import { attributeCauses } from '../scripts/lib/journey.mjs';
import { instructionsOf } from '../scripts/lib/report-data.mjs';

test('a column the connector listed and then rejected is metadata; an unlisted guess is the agent', () => {
  const steps = [
    { ok: true, tool: 'getColumns', input: JSON.stringify({ tableName: 'Projects' }), result: 'Columns: Id, Name, Notes' },
    { ok: false, tool: 'queryData', input: 'SELECT [Notes] FROM [A].[B].[Projects]', error: 'Unrecognized column [Notes] in query for table [Projects]' },
    { ok: false, tool: 'queryData', input: 'SELECT [Text] FROM [A].[B].[Projects]', error: 'Unrecognized column [Text] in query for table [Projects]' },
    { ok: false, tool: 'queryData', input: 'SELECT 1', error: "STMT The catalog 'X' either does not exist or is inaccessible." },
  ];
  attributeCauses(steps);
  assert.deepEqual(steps.slice(1).map(s => s.cause), ['metadata', 'ai', 'instructions']);
});

test('the instructions summary says what better instructions would have prevented, and whose it is today', () => {
  const step = (tool, o) => ({ tool, category: tool === 'queryData' ? 'query' : 'discovery', ...o });
  const rec = (id, steps) => ({ suite: 'business', use_case_id: id, steps });
  const I = instructionsOf([
    rec('U1', [step('getInstructions', { ok: true, result: 'Generic fallback instructions only: use metadata tools' }), step('getTables', { ok: true, result: 'Tasks, Stories' }),
      step('queryData', { ok: false, error_class: 'required_filter', cause: 'instructions' }), step('queryData', { ok: true })]),
    rec('U2', [step('getTables', { ok: true, result: 'Tasks' }), step('queryData', { ok: false, error_class: 'table_not_found', cause: 'ai' }), step('queryData', { ok: true })]),
  ]);
  assert.equal(I.generic, true, 'generic fallback instructions are named as such');
  assert.equal(I.failed_calls, 1);
  const t = Object.fromEntries(I.topics.map(x => [x.key, x]));
  assert.equal(t.filters.charged, true);
  assert.equal(t.vocabulary.charged, false, 'a wrong table guess stays the agent\'s, but instructions would help');
  assert.equal(I.read_first_pct, 50);
});
