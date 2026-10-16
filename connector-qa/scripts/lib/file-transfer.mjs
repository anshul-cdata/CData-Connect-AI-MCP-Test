/* file-transfer.mjs — which stored procedures move file bytes the cloud MCP tools cannot (3.9.4).
 *
 * ConnectAI MCP tools pass plain JSON values: text, numbers, dates. A procedure that needs a local file
 * path, a stream or a download folder cannot be called with one: the path names a disk on the server, not
 * the user's, and a stream has no JSON form. QuickBooks' UploadAttachment is the example that exposed this
 * (FilePath or Content, "neither works through the MCP interface"); the same shape recurs in any
 * connector with attachments or file storage. Until now the skill matched procedures to capabilities by
 * name only and never read their parameters, so such a procedure was mapped "exposed" and the report said
 * "Ready to test" for a use case no agent could ever complete. The call to say so was left to a reviewer
 * who happened to have a usage note about it.
 *
 *   fileTransfer(proc)          → null, or { kind, usable, params, note } from the procedure's parameters
 *   applyFileTransfer(m, procs) → a capability mapping corrected by what its procedure needs
 *
 * It decides only from parameters the connector itself reports ({name, type, required, direction}, the shape
 * the procedure registry already uses) and returns null when they are missing or say nothing about files,
 * so a connector whose parameters were not recorded behaves exactly as before.
 *
 *   upload_needs_file   a path or stream is the only way to supply the file            → not usable
 *   download_to_disk    writes to a folder or stream and returns nothing else           → not usable
 *   upload_base64       the file can be sent as base64 text                              → small files only
 *   download_base64     the file comes back as base64 text (folder and stream optional)  → small files only
 */
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/* A parameter whose type is a byte stream or binary value, or whose name says it is one */
const BINARY_TYPE = /^(binary|varbinary|longvarbinary|blob|longblob|bytea|stream|inputstream|outputstream|bytes|bytearray)$/;
const STREAM_NAME = /^(filestream|inputstream|outputstream|datastream|contentstream|filebytes|bytestream)$/;
/* …or a path on the machine the procedure runs on */
const PATH_NAME = /^(filepath|localfile|localpath|localfilepath|sourcefile|sourcepath|inputfile|inputpath|uploadfile|uploadpath|fullpath|fromfile)$/;
/* where a download is written on that machine */
const OUT_FOLDER = /^(downloadfolder|downloadpath|downloaddirectory|downloadto|saveto|savepath|savefolder|outputfolder|outputpath|outputdirectory|destinationfolder|destinationpath|targetfolder|targetpath|localfolder|localdirectory)$/;
/* a file carried as text */
const BASE64_NAME = /base64|encoded(data|content|file)|filedata|filecontentbase/;
const DOWNLOAD_PROC = /^(download|export|fetch|retrieve|getfile|readfile)/;

const dirOf = p => {
  const d = norm(p.direction ?? p.dir ?? p.parametertype ?? p.kind);
  if (/inout/.test(d)) return 'inout';
  if (/out|return|result/.test(d)) return 'output';
  if (/in/.test(d)) return 'input';
  return 'unknown';
};

/**
 * @param {{name?: string, params?: ({name: string, type?: string, direction?: string}|string)[]}} proc
 * @returns {null | {kind: string, usable: 'no'|'small', params: string[], note: string}}
 */
export function fileTransfer(proc) {
  const raw = Array.isArray(proc?.params) ? proc.params : [];
  const params = raw.map(p => typeof p === 'string' ? { name: p } : p).filter(p => p?.name)
    .map(p => ({ name: p.name, n: norm(p.name), type: norm(p.type ?? p.datatype ?? p.data_type), dir: dirOf(p) }));
  if (!params.length) return null;                                       // nothing recorded: say nothing
  const name = proc.name || 'The procedure';
  const names = ps => ps.map(p => p.name);

  const fileInputs = params.filter(p => p.dir !== 'output' && (BINARY_TYPE.test(p.type) || STREAM_NAME.test(p.n) || PATH_NAME.test(p.n)));
  const folders = params.filter(p => p.dir !== 'output' && OUT_FOLDER.test(p.n));
  const b64 = params.filter(p => BASE64_NAME.test(p.n));
  const b64In = b64.filter(p => p.dir === 'input' || p.dir === 'inout');
  const b64Out = b64.filter(p => p.dir === 'output');
  const download = folders.length > 0 || (DOWNLOAD_PROC.test(norm(proc.name)) && fileInputs.length > 0);

  if (download) {
    /* the download writes to a folder or stream; it is usable only when the bytes also come back as text */
    if (b64Out.length || (b64.length && !b64In.length)) {
      return { kind: 'download_base64', usable: 'small', params: names([...folders, ...fileInputs, ...b64]),
        note: `${name} returns the file as base64 text when the folder and stream are left out, so it works for small files only: every byte passes through the assistant's context.` };
    }
    return { kind: 'download_to_disk', usable: 'no', params: names([...folders, ...fileInputs]),
      note: `${name} writes the file to a folder or stream (${names([...folders, ...fileInputs]).join(', ')}) on the machine that runs the driver and returns nothing the MCP tools can use.` };
  }
  if (fileInputs.length) {
    if (b64In.length) {
      return { kind: 'upload_base64', usable: 'small', params: names([...fileInputs, ...b64In]),
        note: `${name} accepts the file as base64 text (${names(b64In).join(', ')}), so it works for small files only: every byte passes through the assistant's context.` };
    }
    return { kind: 'upload_needs_file', usable: 'no', params: names(fileInputs),
      note: `${name} is listed, but it takes a local file path or a stream (${names(fileInputs).join(', ')}) and has no text alternative. The cloud MCP tools pass only JSON values, so the file bytes cannot be supplied.` };
  }
  return null;
}

/**
 * Correct a capability mapping that points at a procedure needing file transfer. Only an `exposed`
 * mapping is touched: a reviewer's `partly`/`not_exposed` already says what it says.
 * @param {{status: string, exposure?: {kind: string, name: string}[], note?: string}} m
 * @param {{name: string, params?: unknown[]}[]} procs
 */
export function applyFileTransfer(m, procs) {
  if (!m || m.status !== 'exposed') return m;
  for (const e of m.exposure || []) {
    if (e.kind !== 'procedure') continue;
    const proc = (procs || []).find(p => p && p.name === e.name);
    const ft = proc && fileTransfer(proc);
    if (!ft) continue;
    const file_transfer = { kind: ft.kind, procedure: e.name, params: ft.params };
    if (ft.usable === 'no') return { status: 'not_exposed', exposure: [], confidence: 'high', note: ft.note, file_transfer };
    return { ...m, status: 'partly', confidence: 'high', note: ft.note, file_transfer };
  }
  return m;
}
