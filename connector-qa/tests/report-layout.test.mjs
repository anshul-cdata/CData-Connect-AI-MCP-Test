/* Report layout guards. The eval report's side-by-side journeys overflowed into each other (asn-eval1):
 * grid items keep min-width:auto, so the longest unbreakable line — a SQL statement in a <pre>, a JSON
 * input, an error with a URL — set the column width. These checks keep every multi-column grid shrinkable
 * and every long-text block wrapping, in both report templates. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = ['eval-report-template.html', 'capability-report-template.html'];
const css = name => {
  const html = readFileSync(join(here, '..', 'assets', name), 'utf8');
  return html.slice(html.indexOf('<style>'), html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
};
/* [selector list, declarations] for every rule (no nesting except a trailing @media, which is enough here) */
const rules = s => [...s.replace(/@media[^{]*\{/g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => [m[1].trim(), m[2]]);
const decl = (rs, sel) => rs.filter(([s]) => s.split(',').map(x => x.trim()).includes(sel)).map(([, d]) => d).join(';');
const shrinkable = rs => new Set(rs.filter(([, d]) => /min-width:\s*0\b/.test(d)).flatMap(([s]) => s.split(',').map(x => x.trim())));

for (const name of TEMPLATES) {
  test(`${name}: every auto-fit grid lets its columns shrink`, () => {
    const rs = rules(css(name)); const ok = shrinkable(rs);
    const grids = rs.filter(([, d]) => /display:\s*grid/.test(d) && /repeat\(auto-fit/.test(d)).flatMap(([s]) => s.split(',').map(x => x.trim()));
    assert.ok(grids.length, 'expected at least one auto-fit grid');
    const missing = grids.filter(g => !ok.has(`${g}>*`));
    assert.deepEqual(missing, [], `add "${missing.map(g => g + '>*').join(',')}{min-width:0}" so long content wraps instead of overflowing`);
  });

  test(`${name}: journey steps and long-text blocks wrap`, () => {
    const rs = rules(css(name)); const ok = shrinkable(rs);
    assert.ok(ok.has('.jstep>div'), '.jstep>div needs min-width:0 (the step body is a grid item)');
    const pre = decl(rs, 'pre');
    assert.match(pre, /white-space:\s*pre-wrap/, 'pre must wrap (white-space:pre-wrap)');
    assert.match(pre, /overflow-wrap:\s*anywhere/, 'pre must break long tokens (overflow-wrap:anywhere)');
    for (const sel of ['.jerr', '.jres', '.jwhy']) assert.match(decl(rs, sel), /overflow-wrap:\s*anywhere/, `${sel} must break long tokens such as URLs`);
  });
}

test('eval-report-template.html: compare panels can shrink', () => {
  const ok = shrinkable(rules(css('eval-report-template.html')));
  assert.ok(ok.has('.cmp>*') && ok.has('.panel'), 'side-by-side .cmp columns and .panel need min-width:0');
});

import { failedCalls } from '../scripts/lib/report-data.mjs';
test('failed queries: identical failures fold into one row, connector problems first, ok calls ignored', () => {
  const step = (o) => ({ tool: 'queryData', ok: false, category: 'query', ...o });
  const recs = [
    { tc_id: 'TC-1', use_case_id: 'UC-1', attempt: 1, steps: [step({ input: 'SELECT a', error: 'bad column', error_class: 'column_not_found', cause: 'ai' }), { tool: 'queryData', ok: true }] },
    { tc_id: 'TC-1', use_case_id: 'UC-1', attempt: 2, steps: [step({ input: 'SELECT a', error: 'bad column', error_class: 'column_not_found', cause: 'ai', recovered: true })] },
    { tc_id: 'TC-2', use_case_id: 'UC-2', attempt: 1, steps: [step({ input: 'UPDATE t', error: 'Unable to perform UPDATE', error_class: 'unsupported_operation', cause: 'connector' })] },
  ];
  const rows = failedCalls(recs);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].owner, 'Connector');
  const ai = rows.find(r => r.cause === 'ai');
  assert.equal(ai.count, 2);
  assert.deepEqual(ai.tests, ['UC-1', 'UC-1 · attempt 2']);
  assert.equal(ai.recovered, true);
});

for (const name of TEMPLATES) {
  test(`${name}: summary metrics carry plain-language tooltips`, () => {
    const html = readFileSync(join(here, '..', 'assets', name), 'utf8');
    const m = html.match(/const HELP = (\{[\s\S]*?\n\});/);
    assert.ok(m, 'HELP dictionary missing');
    const help = JSON.parse(m[1]);
    for (const k of ['score', 'grades', 'correct', 'first', ...(name.startsWith('eval') ? ['cost'] : [])]) assert.ok(help[k] && help[k].length > 30, `HELP.${k} missing or too short`);
    /* verdict tooltips are looked up by prefix: HELP['v_'+verdict] */
    for (const k of Object.keys(help)) assert.ok(html.includes(`'${k}')`) || html.includes(`HELP.${k}`) || (/^v_/.test(k) && html.includes("'v_'+")), `HELP.${k} is never shown`);
    assert.match(html, /#tipbox\{position:fixed/, 'tooltip box must be position:fixed so scroll containers do not clip it');
    assert.match(html, /addEventListener\('focusin'/, 'tooltips must open on keyboard focus too');
  });
}

/* Wording agreed with the report's readers: "Agent used: <model>" (not "Agent under test") and the eval
 * question names the ConnectAI MCP, not "the connector". */
test('report wording: "Agent used" label and ConnectAI MCP title', () => {
  for (const name of [...TEMPLATES, 'report-template.html']) {
    const html = readFileSync(join(here, '..', 'assets', name), 'utf8');
    assert.ok(!/Agent under test/.test(html), `${name} still says "Agent under test"`);
    assert.ok(/Agent used/.test(html), `${name} lacks the "Agent used" label`);
  }
  const ev = readFileSync(join(here, '..', 'assets', 'eval-report-template.html'), 'utf8');
  assert.ok(ev.includes('Which AI model works best with the ${esc(D.connector)} ConnectAI MCP?'));
});

/* 3.3.3: report text is for readers. A capability note says what works and what does not — never how
 * the mapping was reached ("Was wrongly not_exposed: …") — and a judge's reason never shows field names. */
import { readerNote } from '../scripts/lib/capabilities.mjs';
import { readable } from '../scripts/lib/report-data.mjs';
test('capability notes drop review history and status codes', () => {
  assert.equal(readerNote('Was wrongly not_exposed: UploadAttachment(TaskId, Name, Content) uploads a file to a task. Links are not supported.'),
    'UploadAttachment(TaskId, Name, Content) uploads a file to a task. Links are not supported.');
  assert.equal(readerNote('Name match to DuplicateTask was wrong; no procedure duplicates a portfolio.'), 'No procedure duplicates a portfolio.');
  assert.equal(readerNote('Generic /memberships is split across three tables; custom-field memberships are not exposed.'),
    'Generic /memberships is split across three tables; custom-field memberships are not exposed.', 'a plain note is left alone');
  assert.equal(readerNote('marked product_only: forms live in the app'), 'Marked not applicable: forms live in the app');
});
test('judge and checker explanations use words, not field names', () => {
  assert.equal(readable('The reference query failed, so judged from expected_behavior: the agent should have said so.'),
    'The reference query failed, so judged from the expected behaviour: the agent should have said so.');
  assert.equal(readable('compared with reference_sql'), 'compared with the reference query');
});
