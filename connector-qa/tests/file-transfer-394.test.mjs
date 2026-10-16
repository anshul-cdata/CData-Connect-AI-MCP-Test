/* 3.9.4 — procedures that move file bytes the cloud MCP tools cannot.
 *
 * QuickBooks Online's UploadAttachment takes a local file path or a stream; ConnectAI MCP tools pass only
 * JSON values, so no agent can ever complete an upload through it. The skill matched procedures to
 * capabilities by name and never read their parameters, so that upload was mapped "exposed" and a use case
 * built on it showed "Ready to test". Only a reviewer who happened to have a usage note caught it. These
 * tests hold the new check to account: the parameters decide, a missing parameter list decides nothing, and
 * a connector that never had this shape maps exactly as before.
 *
 * The parameter lists below are modelled on the names in the QuickBooks usage instructions (FilePath and
 * Content for the upload; DownloadFolder, FileStream and a base64 output for the downloads) — documentation,
 * not live metadata; the live connection was not reachable when this was written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fileTransfer, applyFileTransfer } from '../scripts/lib/file-transfer.mjs';
import { mapToConnector } from '../scripts/lib/capabilities.mjs';

const SK = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = (name, type = 'VARCHAR', direction = 'Input', required = false) => ({ name, type, direction, required });

const UPLOAD_ATTACHMENT = { name: 'UploadAttachment', params: [P('FilePath'), P('Content', 'BINARY'), P('FileName'), P('ContentType'), P('AttachableRef', 'VARCHAR', 'Input', true)] };
const DOWNLOAD_PDF = { name: 'DownloadPDF', params: [P('TxnType', 'VARCHAR', 'Input', true), P('TxnID', 'VARCHAR', 'Input', true), P('DownloadFolder'), P('FileStream', 'BINARY'),
  P('Base64EncodedData', 'VARCHAR', 'Output'), P('Result', 'VARCHAR', 'Output'), P('PDFFile', 'VARCHAR', 'Output')] };
const SEND_INVOICE = { name: 'SendInvoice', params: [P('InvoiceId', 'VARCHAR', 'Input', true), P('EmailAddress'), P('Result', 'VARCHAR', 'Output')] };

test('an upload whose only inputs are a path and a stream cannot be used through the MCP tools', () => {
  const r = fileTransfer(UPLOAD_ATTACHMENT);
  assert.equal(r.kind, 'upload_needs_file');
  assert.equal(r.usable, 'no');
  assert.deepEqual(r.params, ['FilePath', 'Content'], 'it names the parameters that make it unusable');
  assert.match(r.note, /UploadAttachment is listed, but it takes a local file path or a stream \(FilePath, Content\)/);
  assert.match(r.note, /cannot be supplied/);
});

test('an upload that also accepts base64 text is usable for small files, and says so', () => {
  const r = fileTransfer({ name: 'UploadFile', params: [P('FilePath'), P('ContentBase64', 'VARCHAR', 'Input'), P('FolderId', 'VARCHAR', 'Input', true)] });
  assert.equal(r.kind, 'upload_base64');
  assert.equal(r.usable, 'small');
  assert.match(r.note, /small files only/);
});

test('a download that returns base64 when the folder and stream are left out is usable for small files', () => {
  const r = fileTransfer(DOWNLOAD_PDF);
  assert.equal(r.kind, 'download_base64');
  assert.equal(r.usable, 'small');
  assert.match(r.note, /every byte passes through the assistant's context/);
});

test('a download that only writes to a folder returns nothing the MCP tools can use', () => {
  const r = fileTransfer({ name: 'DownloadFile', params: [P('FileId', 'VARCHAR', 'Input', true), P('DownloadFolder', 'VARCHAR', 'Input', true), P('Result', 'VARCHAR', 'Output')] });
  assert.equal(r.kind, 'download_to_disk');
  assert.equal(r.usable, 'no');
});

test('procedures with no file parameters, or no recorded parameters, are left alone', () => {
  assert.equal(fileTransfer(SEND_INVOICE), null, 'SendInvoice takes an id and an address');
  assert.equal(fileTransfer({ name: 'VoidInvoice', params: [P('InvoiceId'), P('SyncToken')] }), null);
  assert.equal(fileTransfer({ name: 'UploadAttachment' }), null, 'no parameter list: it says nothing rather than guessing');
  assert.equal(fileTransfer({ name: 'UploadAttachment', params: [] }), null);
  /* a text column called Content is not a stream, and a remote folder id is not a download folder */
  assert.equal(fileTransfer({ name: 'CreateNote', params: [P('Content', 'VARCHAR'), P('FolderId', 'VARCHAR')] }), null);
  /* parameters given as bare names carry no type, so only an unmistakable name counts */
  assert.equal(fileTransfer({ name: 'SendInvoice', params: ['InvoiceId', 'EmailAddress'] }), null);
  assert.equal(fileTransfer({ name: 'UploadAttachment', params: ['FilePath', 'FileStream'] })?.kind, 'upload_needs_file');
});

test('applyFileTransfer corrects only an exposed mapping to a procedure', () => {
  const procs = [UPLOAD_ATTACHMENT, DOWNLOAD_PDF, SEND_INVOICE];
  const exposed = name => ({ status: 'exposed', exposure: [{ kind: 'procedure', name }], confidence: 'high' });
  const up = applyFileTransfer(exposed('UploadAttachment'), procs);
  assert.equal(up.status, 'not_exposed');
  assert.deepEqual(up.exposure, []);
  assert.equal(up.file_transfer.kind, 'upload_needs_file');
  const dl = applyFileTransfer(exposed('DownloadPDF'), procs);
  assert.equal(dl.status, 'partly');
  assert.equal(dl.exposure[0].name, 'DownloadPDF', 'a partly usable procedure stays attached');
  assert.deepEqual(applyFileTransfer(exposed('SendInvoice'), procs), exposed('SendInvoice'));
  /* a table read, or a mapping a reviewer already settled, is not touched */
  const table = { status: 'exposed', exposure: [{ kind: 'table', name: 'Invoices', op: 'SELECT' }] };
  assert.equal(applyFileTransfer(table, procs), table);
  const reviewed = { status: 'partly', exposure: [{ kind: 'procedure', name: 'UploadAttachment' }], note: 'kept' };
  assert.equal(applyFileTransfer(reviewed, procs), reviewed);
  assert.equal(applyFileTransfer(null, procs), null);
});

/* ── through the real mapping ───────────────────────────────────────────────── */
const action = (id, operation_id, noun) => ({ id, kind: 'action', operation_id, action: operation_id, noun, resource: noun, path: `/${noun}`, method: 'POST' });
const CAPS = () => [action('CAP-uploadattachment', 'uploadAttachment', 'Attachable'), action('CAP-downloadpdf', 'downloadPdf', 'Invoice'), action('CAP-sendinvoice', 'sendInvoice', 'Invoice')];
const status = (caps, id) => caps.find(c => c.id === id).mapping;

test('mapToConnector: before parameters are recorded an upload looks usable; with them it does not', () => {
  const bare = mapToConnector(CAPS(), { objects: [], physical: { procedures: [{ name: 'UploadAttachment' }, { name: 'DownloadPDF' }, { name: 'SendInvoice' }] } });
  assert.equal(status(bare, 'CAP-uploadattachment').status, 'exposed', 'the old behaviour: matched by name alone');
  const known = mapToConnector(CAPS(), { objects: [], physical: { procedures: [UPLOAD_ATTACHMENT, DOWNLOAD_PDF, SEND_INVOICE] } });
  const up = status(known, 'CAP-uploadattachment');
  assert.equal(up.status, 'not_exposed');
  assert.match(up.note, /local file path or a stream/);
  assert.equal(up.file_transfer.procedure, 'UploadAttachment');
  assert.equal(status(known, 'CAP-downloadpdf').status, 'partly');
  assert.equal(status(known, 'CAP-sendinvoice').status, 'exposed', 'an ordinary action procedure is unaffected');
});

test('mapToConnector: a connector without file procedures maps exactly as before', () => {
  const procs = [SEND_INVOICE, { name: 'VoidInvoice', params: [P('InvoiceId'), P('SyncToken')] }];
  const caps = [action('CAP-sendinvoice', 'sendInvoice', 'Invoice'), action('CAP-voidinvoice', 'voidInvoice', 'Invoice')];
  const withParams = mapToConnector(caps, { objects: [], physical: { procedures: procs } });
  const without = mapToConnector(caps, { objects: [], physical: { procedures: procs.map(p => ({ name: p.name })) } });
  assert.deepEqual(withParams.map(c => c.mapping.status), without.map(c => c.mapping.status));
  assert.ok(withParams.every(c => !c.mapping.file_transfer));
});

test('mapToConnector never recomputes a mapping a reviewer has already settled', () => {
  const caps = [{ ...action('CAP-uploadattachment', 'uploadAttachment', 'Attachable'), review: true, mapping: { status: 'exposed', exposure: [{ kind: 'procedure', name: 'UploadAttachment' }], confidence: 'reviewed' } }];
  const out = mapToConnector(caps, { objects: [], physical: { procedures: [UPLOAD_ATTACHMENT] } });
  assert.equal(out[0].mapping.status, 'exposed', 'a person or reviewer’s decision stands');
});

/* ── the nudge when parameters were never recorded ───────────────────────────── */
function setup(procedures) {
  const dir = join(mkdtempSync(join(tmpdir(), 'cqa-ft-')), 'Demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Demo_knowledge.json'), JSON.stringify({ schema_version: '2.0.0', connector: 'Demo', objects: [{ name: 'Invoices' }], physical: { procedures } }));
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'Demo API', version: '1' },
    paths: { '/invoices/{id}/send': { post: { operationId: 'sendInvoice', summary: 'Send an invoice' } }, '/upload': { post: { operationId: 'uploadAttachment', summary: 'Upload an attachment' } } } }));
  /* map exits 3 while mappings still await review: that is not a failure here, only its output matters */
  const run = args => { const r = spawnSync(process.execPath, [join(SK, 'scripts', 'capability-list.mjs'), ...args, '--dir', dir], { encoding: 'utf8' }); return { code: r.status, out: String(r.stdout) + String(r.stderr) }; };
  assert.equal(run(['read', '--spec', join(dir, 'spec.json')]).code, 0);
  return args => run(args).out;
}

test('capability-list map warns when procedures have no recorded parameters, and not when they do', () => {
  const warn = setup([{ name: 'UploadAttachment' }, { name: 'SendInvoice', params: [P('InvoiceId')] }])(['map']);
  assert.match(warn, /1 of 2 procedure\(s\) have no parameter list recorded \(UploadAttachment\)/);
  assert.match(warn, /getProcedureParameters/);
  const quiet = setup([UPLOAD_ATTACHMENT, SEND_INVOICE])(['map']);
  assert.doesNotMatch(quiet, /no parameter list recorded/);
  const none = setup([])(['map']);
  assert.doesNotMatch(none, /no parameter list recorded/, 'a connector with no procedures has nothing to record');
});
