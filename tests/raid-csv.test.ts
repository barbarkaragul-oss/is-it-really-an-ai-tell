import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CsvRows, Host, RaidSourceError, checkSource, readWindow, refuseRange, sameEtag, namedRow,
  hasMainSetting, isMeasuredRow, RAID_COLUMNS, type SourceFile,
} from '../collector/raid-csv.js';
import { readDomain, cacheMatches, flatText, genreArms, generationText, unquoted, rowsFor, readCache, titlesOf, type WindowsIndex } from '../collector/fetch-raid.js';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { byId, sentences } from '../src/markers.js';

const enc = new TextEncoder();
type Row = { fields: string[]; start: number; end: number };

function parseAll(bytes: Uint8Array, cuts: number[], start = 0): Row[] {
  const rows: Row[] = [];
  const p = new CsvRows(start, (fields, s, e) => rows.push({ fields, start: s, end: e }));
  let at = 0;
  for (const c of [...cuts, bytes.length]) { p.push(bytes.subarray(at, c)); at = c; }
  p.finish();
  return rows;
}

// Synthetic: quoted line breaks of both kinds, a doubled quote, empty fields quoted and not, a
// character outside ASCII, and a CRLF row end.
const SAMPLE = 'a,b,c\n'
  + '1,"two\nlines","say ""hi"""\n'
  + ',"",x\r\n'
  + '"é — ’","a,b","CR\r\nLF"\n'
  + 'last,,\n';
const EXPECTED = [
  ['a', 'b', 'c'],
  ['1', 'two\nlines', 'say "hi"'],
  ['', '', 'x'],
  ['é — ’', 'a,b', 'CR\r\nLF'],
  ['last', '', ''],
];

test('CSV rows: quoted line breaks, doubled quotes, empty fields, CRLF, and byte spans', () => {
  const bytes = enc.encode(SAMPLE);
  const rows = parseAll(bytes, []);
  assert.deepEqual(rows.map((r) => r.fields), EXPECTED);
  // the spans tile the input: each row starts where the one before ended
  assert.equal(rows[0]!.start, 0);
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i]!.start, rows[i - 1]!.end);
  assert.equal(rows[rows.length - 1]!.end, bytes.length);
  // and an offset is carried through
  assert.equal(parseAll(bytes, [], 1000)[1]!.start, 1000 + rows[1]!.start);
});

test('CSV rows: the same rows wherever the chunks break, inside a quote, a "" or a multi-byte character', () => {
  const bytes = enc.encode(SAMPLE);
  const whole = parseAll(bytes, []);
  for (let cut = 1; cut < bytes.length; cut++) assert.deepEqual(parseAll(bytes, [cut]), whole, `split at ${cut}`);
  const everyByte = Array.from({ length: bytes.length - 1 }, (_, i) => i + 1);
  assert.deepEqual(parseAll(bytes, everyByte), whole, 'one byte at a time');
});

test('CSV rows: malformed input is an error, not a guess', () => {
  const bad = (s: string): void => {
    assert.throws(() => parseAll(enc.encode(s), []), RaidSourceError, JSON.stringify(s));
  };
  bad('a,b"c,d\n');          // a quote inside an unquoted field
  bad('"a"b,c\n');           // text after a closing quote
  bad('a,b\rc\n');           // a bare carriage return
  bad('a,"open\n');          // the bytes end inside a quoted field
  bad('a,b');                // the bytes end inside a row
  // a window that starts inside a quoted field shows up at once as a malformed row
  const inside = enc.encode(SAMPLE).subarray(SAMPLE.indexOf('lines'));
  assert.throws(() => parseAll(inside, []), RaidSourceError);
});

test('CSV rows: after a break, resuming from `complete` hands out each row once', () => {
  const bytes = enc.encode(SAMPLE);
  const whole = parseAll(bytes, []);
  for (let cut = 1; cut < bytes.length; cut++) {
    const rows: Row[] = [];
    const p = new CsvRows(0, (fields, s, e) => rows.push({ fields, start: s, end: e }));
    p.push(bytes.subarray(0, cut));
    const from = p.complete;
    assert.ok(from === 0 || whole.some((r) => r.end === from), `complete (${from}) is a row end`);
    p.resume();
    p.push(bytes.subarray(from));
    p.finish();
    assert.deepEqual(rows, whole, `broken at ${cut}`);
  }
});

// ---- a local host

interface Served {
  url: string;
  requests: { method: string; range: string | undefined; ua: string | undefined; encoding: string | undefined }[];
  close: () => Promise<void>;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, n: number) => void | Promise<void>;

async function serve(handler: Handler): Promise<Served> {
  const requests: Served['requests'] = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method!, range: req.headers.range, ua: req.headers['user-agent'], encoding: req.headers['accept-encoding'] as string | undefined });
    void handler(req, res, requests.length);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/train_none.csv`,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

const ETAG = '"abc123-8"';
const fast = (): Host => new Host({ minGapMs: 0, backoffMs: 5, retries: 3, log: () => {} });

/** a RAID-shaped file: header, then rows with long quoted generations that hold line breaks */
function raidFile(n: number): { bytes: Uint8Array; rowStarts: number[]; rows: string[][] } {
  const header = RAID_COLUMNS.join(',') + '\n';
  const models = ['human', 'llama-chat', 'mistral-chat', 'chatgpt', 'gpt4', 'mpt'];
  const rows: string[][] = [];
  let text = header;
  const rowStarts: number[] = [];
  for (let i = 0; i < n; i++) {
    const model = models[i % models.length]!;
    const doc = `doc-${Math.floor(i / models.length)}`;
    const generation = `Row ${i} says "hello".\n\n- an item\n- another, with a comma\n${'word '.repeat(40 + i)}`;
    const fields = [`id-${i}`, `id-${i}`, doc, model, model === 'human' ? '' : 'greedy', model === 'human' ? '' : 'no', 'none', 'reddit', `Title ${i}`, 'Write a post', generation];
    rows.push(fields);
    rowStarts.push(enc.encode(text).length);
    text += fields.map((f) => (/[",\n\r]/.test(f) ? `"${f.replaceAll('"', '""')}"` : f)).join(',') + '\n';
  }
  return { bytes: enc.encode(text), rowStarts, rows };
}

/** answer ranges properly, in small writes, so the client sees many chunks */
function rangeServer(bytes: Uint8Array, etag = ETAG): Handler {
  return async (req, res) => {
    const headers = { etag, 'accept-ranges': 'bytes', 'content-type': 'text/csv' };
    if (req.method === 'HEAD') { res.writeHead(200, { ...headers, 'content-length': bytes.length }); res.end(); return; }
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (!m) { res.writeHead(200, { ...headers, 'content-length': bytes.length }); res.end(bytes); return; }
    const a = Number(m[1]), b = Number(m[2]);
    const body = bytes.subarray(a, b + 1);
    res.writeHead(206, { ...headers, 'content-length': body.length, 'content-range': `bytes ${a}-${b}/${bytes.length}` });
    for (let i = 0; i < body.length; i += 97) {
      res.write(body.subarray(i, i + 97));
      await new Promise((r) => setImmediate(r));
    }
    res.end();
  };
}

test('range read: one window, streamed, parsed into the rows it holds', async () => {
  const f = raidFile(30);
  const s = await serve(rangeServer(f.bytes));
  try {
    const file: SourceFile = { url: s.url, etag: ETAG, size: f.bytes.length };
    await checkSource(file, fast());
    const win = { start: f.rowStarts[3]!, end: f.rowStarts[20]! };
    const got: Row[] = [];
    const read = await readWindow(file, win, (fields, start, end) => got.push({ fields, start, end }), fast());
    assert.deepEqual(got.map((r) => r.fields), f.rows.slice(3, 20));
    assert.deepEqual(got.map((r) => r.start), f.rowStarts.slice(3, 20));
    assert.deepEqual(read, { rows: 17, bytes: win.end - win.start, requests: 1, resumed: 0 });
    // one HEAD, one GET, both naming the project, neither asking for a compressed body (fetch adds
    // its own "identity" to a range request, so the header may say it twice)
    assert.deepEqual(s.requests.map((r) => [r.method, r.range]), [['HEAD', undefined], ['GET', `bytes=${win.start}-${win.end - 1}`]]);
    for (const r of s.requests) {
      assert.match(r.ua ?? '', /is-it-really-an-ai-tell/);
      assert.deepEqual([...new Set((r.encoding ?? '').split(/,\s*/))], ['identity']);
    }
  } finally { await s.close(); }
});

test('range read: a 200 to a range request is refused before its body is read, and asked again a few times', async () => {
  const big = new Uint8Array(64 * 1024 * 1024).fill(0x61);
  const sent: number[] = [];
  let finished = false;
  const s = await serve(async (req, res, n) => {
    sent[n - 1] = 0;
    res.writeHead(200, { etag: ETAG, 'content-length': big.length });
    for (let i = 0; i < big.length && !res.destroyed; i += 65536) {
      if (!res.write(big.subarray(i, i + 65536))) {
        // whichever comes first; the other listener is removed, so a long send does not pile them up
        await new Promise<void>((r) => {
          const done = (): void => { res.off('drain', done); res.off('close', done); r(); };
          res.once('drain', done);
          res.once('close', done);
        });
      }
      sent[n - 1]! += 65536;
    }
    if (!res.destroyed) res.end(() => { finished = true; });
  });
  try {
    const file: SourceFile = { url: s.url, etag: ETAG, size: big.length };
    await assert.rejects(readWindow(file, { start: 0, end: 1000 }, () => {}, fast()), (e: Error) => e instanceof RaidSourceError && /200 instead of 206/.test(e.message));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(finished, false, 'the server never finished sending the file');
    assert.ok(Math.max(...sent) < big.length / 4, `at most ${Math.max(...sent)} of ${big.length} bytes left the server on any attempt`);
    assert.equal(s.requests.length, 4, 'the request and three more, then an error');
  } finally { await s.close(); }
  // a whole file under another ETag is a changed file: refused at once
  const other = await serve((req, res) => { res.writeHead(200, { etag: '"changed-3"', 'content-length': 10 }); res.end('0123456789'); });
  try {
    await assert.rejects(readWindow({ url: other.url, etag: ETAG, size: 10 }, { start: 0, end: 5 }, () => {}, fast()), RaidSourceError);
    assert.equal(other.requests.length, 1);
  } finally { await other.close(); }
});

test('range read: a host that ignores the range once is asked again, and the read goes on', async () => {
  const f = raidFile(12);
  const proper = rangeServer(f.bytes);
  const s = await serve((req, res, n) => {
    if (n === 1) { res.writeHead(200, { etag: ETAG, 'content-length': f.bytes.length }); res.end(f.bytes); return; }
    return proper(req, res, n);
  });
  try {
    const file: SourceFile = { url: s.url, etag: ETAG, size: f.bytes.length };
    const got: string[] = [];
    const read = await readWindow(file, { start: f.rowStarts[1]!, end: f.rowStarts[4]! }, (fields) => got.push(fields[0]!), fast());
    assert.deepEqual(got, ['id-1', 'id-2', 'id-3']);
    assert.equal(read.requests, 2);
    assert.equal(read.resumed, 0);
  } finally { await s.close(); }
});

test('range read: a body that breaks inside a quoted field resumes from the last complete row', async () => {
  const f = raidFile(24);
  const win = { start: f.rowStarts[1]!, end: f.bytes.length };
  // the first answer stops in the middle of row 9's generation, after a line break inside its
  // quotes, when rows 1..8 are whole
  const row9 = new TextDecoder().decode(f.bytes.subarray(f.rowStarts[9]!, f.rowStarts[10]!));
  const breakAt = f.rowStarts[9]! + enc.encode(row9.slice(0, row9.indexOf('- an item') + 4)).length;
  assert.ok(new TextDecoder().decode(f.bytes.subarray(f.rowStarts[9]!, breakAt)).endsWith('.\n\n- an'), 'the break is inside the quoted field');
  const proper = rangeServer(f.bytes);
  const s = await serve(async (req, res, n) => {
    if (n > 1) return proper(req, res, n);
    res.writeHead(206, { etag: ETAG, 'content-length': win.end - win.start, 'content-range': `bytes ${win.start}-${win.end - 1}/${f.bytes.length}` });
    res.write(f.bytes.subarray(win.start, breakAt));
    // let the client take those bytes before the connection goes
    await new Promise((r) => setTimeout(r, 300));
    res.socket!.destroy();
  });
  try {
    const file: SourceFile = { url: s.url, etag: ETAG, size: f.bytes.length };
    const got: Row[] = [];
    const read = await readWindow(file, win, (fields, start, end) => got.push({ fields, start, end }), fast());
    assert.deepEqual(got.map((r) => r.fields), f.rows.slice(1), 'every row once, in order');
    assert.equal(read.resumed, 1);
    assert.deepEqual(s.requests.map((r) => r.range), [`bytes=${win.start}-${win.end - 1}`, `bytes=${f.rowStarts[9]}-${win.end - 1}`]);
  } finally { await s.close(); }
});

test('range read: a changed file is refused, whether HEAD or the range answer says so', async () => {
  const f = raidFile(12);
  const s = await serve(rangeServer(f.bytes, '"changed-1"'));
  try {
    const file: SourceFile = { url: s.url, etag: ETAG, size: f.bytes.length };
    await assert.rejects(checkSource(file, fast()), (e: Error) => e instanceof RaidSourceError && /measured again/.test(e.message));
    await assert.rejects(readWindow(file, { start: f.rowStarts[1]!, end: f.rowStarts[4]! }, () => {}, fast()), (e: Error) => e instanceof RaidSourceError && /ETag/.test(e.message));
    // the same bytes under another size are another file too
    await assert.rejects(checkSource({ ...file, etag: '"changed-1"', size: f.bytes.length + 1 }, fast()), RaidSourceError);
  } finally { await s.close(); }
  // a weak validator for the same tag is the same file
  const w = await serve(rangeServer(f.bytes, `W/${ETAG}`));
  try {
    const file: SourceFile = { url: w.url, etag: ETAG, size: f.bytes.length };
    await checkSource(file, fast());
    const read = await readWindow(file, { start: f.rowStarts[1]!, end: f.rowStarts[4]! }, () => {}, fast());
    assert.equal(read.rows, 3);
  } finally { await w.close(); }
  assert.equal(sameEtag('W/"x"', '"x"'), true);
  assert.equal(sameEtag(null, '"x"'), false);
});

test('range read: a Content-Range, length or encoding other than the one asked for is refused', () => {
  const file: SourceFile = { url: 'x', etag: ETAG, size: 1000 };
  const answer = (headers: Record<string, string>, status = 206): Response => new Response(null, { status, headers: { etag: ETAG, ...headers } });
  assert.equal(refuseRange(answer({ 'content-range': 'bytes 10-19/1000', 'content-length': '10' }), file, 10, 19), null);
  assert.match(refuseRange(answer({ 'content-range': 'bytes 0-19/1000' }), file, 10, 19)!, /Content-Range/);
  assert.match(refuseRange(answer({ 'content-range': 'bytes 10-19/2000' }), file, 10, 19)!, /Content-Range/);
  assert.match(refuseRange(answer({}), file, 10, 19)!, /Content-Range/);
  assert.match(refuseRange(answer({ 'content-range': 'bytes 10-19/1000', 'content-length': '11' }), file, 10, 19)!, /Content-Length/);
  assert.match(refuseRange(answer({ 'content-range': 'bytes 10-19/1000', 'content-encoding': 'gzip' }), file, 10, 19)!, /gzip/);
  assert.match(refuseRange(answer({ 'content-range': 'bytes 10-19/1000' }, 200), file, 10, 19)!, /200/);
});

test('range read: a 429 waits and tries again; a window that does not end on a row is an error', async () => {
  const f = raidFile(12);
  const proper = rangeServer(f.bytes);
  const s = await serve((req, res, n) => {
    if (n === 1) { res.writeHead(429, { 'retry-after': '0' }); res.end(); return; }
    return proper(req, res, n);
  });
  try {
    const file: SourceFile = { url: s.url, etag: ETAG, size: f.bytes.length };
    const read = await readWindow(file, { start: f.rowStarts[1]!, end: f.rowStarts[5]! }, () => {}, fast());
    assert.equal(read.rows, 4);
    assert.equal(s.requests.length, 2);
    await assert.rejects(readWindow(file, { start: f.rowStarts[1]!, end: f.rowStarts[5]! + 3 }, () => {}, fast()), /end inside a row/);
  } finally { await s.close(); }
});

// ---- the rows kept, and what the collector makes of them

test('the main setting is explicit: greedy without a penalty, and a human row has no setting', () => {
  const writers = new Set(['human', 'gpt4', 'llama-chat']);
  const row = (model: string, decoding: string, repetition_penalty: string, extra: Partial<Record<'attack' | 'domain', string>> = {}) =>
    ({ model, decoding, repetition_penalty, attack: 'none', domain: 'reddit', ...extra });
  assert.equal(isMeasuredRow(row('gpt4', 'greedy', 'no'), 'reddit', writers), true);
  assert.equal(isMeasuredRow(row('human', '', ''), 'reddit', writers), true);
  for (const [d, p] of [['sampling', 'no'], ['greedy', 'yes'], ['sampling', 'yes'], ['', '']]) {
    assert.equal(isMeasuredRow(row('llama-chat', d!, p!), 'reddit', writers), false, `${d}/${p}`);
  }
  assert.equal(isMeasuredRow(row('human', 'greedy', 'no'), 'reddit', writers), false, 'a human row with a setting');
  assert.equal(isMeasuredRow(row('gpt4', 'greedy', 'no', { attack: 'homoglyph' }), 'reddit', writers), false);
  assert.equal(isMeasuredRow(row('gpt4', 'greedy', 'no', { domain: 'wiki' }), 'reddit', writers), false);
  assert.equal(isMeasuredRow(row('mpt', 'greedy', 'no'), 'reddit', writers), false);
  // the parquet hands a human row's missing setting over as null, which the collector reads as empty
  assert.equal(hasMainSetting({ model: 'human', decoding: '', repetition_penalty: '' }), true);
  assert.throws(() => namedRow(['a'], RAID_COLUMNS), RaidSourceError);
  assert.throws(() => namedRow(['a', 'b'], ['id', 'model']), /no "adv_source_id" column/);
});

function indexFor(url: string, f: ReturnType<typeof raidFile>, windows: WindowsIndex['domains'][string]['windows']): WindowsIndex {
  return { about: '', file: { url, etag: ETAG, size: f.bytes.length, lastModified: '', columns: [...RAID_COLUMNS] }, domains: { reddit: { windows } } };
}

test('a domain read keeps the measured rows and checks every count the index recorded', async () => {
  const f = raidFile(24);
  const s = await serve(rangeServer(f.bytes));
  try {
    const windows = [{ name: 'A', holds: '', start: f.rowStarts[0]!, end: f.rowStarts[12]! }, { name: 'B', holds: '', start: f.rowStarts[12]!, end: f.bytes.length }];
    const bare = indexFor(s.url, f, windows);
    await assert.rejects(readDomain(bare, 'reddit', fast()), /no recorded row count/);
    const first = await readDomain(bare, 'reddit', fast(), true);
    // 24 rows, 4 of them mpt: 20 kept, in file order
    assert.equal(first.rows.length, 20);
    assert.deepEqual(first.rows.slice(0, 2).map((r) => [r.model, r.source_id]), [['human', 'doc-0'], ['llama-chat', 'doc-0']]);
    assert.deepEqual(first.windows.map((w) => [w.rows, w.firstId, w.lastId]), [[12, 'id-0', 'id-11'], [12, 'id-12', 'id-23']]);
    assert.deepEqual(first.windows[0]!.rowsByModel, { chatgpt: 2, gpt4: 2, human: 2, 'llama-chat': 2, 'mistral-chat': 2, mpt: 2 });

    const recorded = indexFor(s.url, f, windows.map((w, i) => ({ ...w, ...first.windows[i]! })));
    const again = await readDomain(recorded, 'reddit', fast());
    assert.deepEqual(again.rows, first.rows);
    assert.equal(cacheMatches(again, recorded, 'reddit'), true);
    assert.equal(cacheMatches(again, bare, 'reddit'), false, 'an index without counts never validates a cache');
    assert.equal(cacheMatches({ ...again, format: again.format + 1 }, recorded, 'reddit'), false);
    assert.equal(cacheMatches({ ...again, file: { ...again.file, etag: '"other"' } }, recorded, 'reddit'), false);
    assert.equal(cacheMatches({ ...again, writers: ['human', 'gpt4'] }, recorded, 'reddit'), false, 'rows kept for other writers');
    assert.equal(cacheMatches({ ...again, windows: again.windows.map((w) => ({ ...w, end: w.end - 1 })) }, recorded, 'reddit'), false);

    const wrongCount = indexFor(s.url, f, recorded.domains.reddit!.windows.map((w, i) => (i ? { ...w, rows: 11 } : w)));
    await assert.rejects(readDomain(wrongCount, 'reddit', fast()), /the index recorded 11/);
    const wrongFirst = indexFor(s.url, f, recorded.domains.reddit!.windows.map((w, i) => (i ? w : { ...w, firstId: 'id-99' })));
    await assert.rejects(readDomain(wrongFirst, 'reddit', fast()), /starts with row id-0, expected id-99/);
    await assert.rejects(readDomain(recorded, 'wiki', fast()), /no windows for the "wiki" domain/);
    // a window reaching outside the domain
    const other = raidFile(6);
    const mixed = new TextDecoder().decode(other.bytes).replace(/,reddit,/, ',wiki,');
    const m = await serve(rangeServer(enc.encode(mixed)));
    try {
      const idx: WindowsIndex = { ...indexFor(m.url, other, [{ name: 'A', holds: '', start: other.rowStarts[0]!, end: enc.encode(mixed).length }]) };
      idx.file.size = enc.encode(mixed).length;
      await assert.rejects(readDomain(idx, 'reddit', fast(), true), /holds a wiki row/);
    } finally { await m.close(); }
  } finally { await s.close(); }
});

test('a duplicate main-setting row for one document is an error', async () => {
  const f = raidFile(6);
  // row 4 is gpt4's text for doc-0; the file ends with it a second time
  const again = f.bytes.subarray(f.rowStarts[4]!, f.rowStarts[5]!);
  const bytes = new Uint8Array(f.bytes.length + again.length);
  bytes.set(f.bytes);
  bytes.set(again, f.bytes.length);
  const s = await serve(rangeServer(bytes));
  try {
    const idx = indexFor(s.url, f, [{ name: 'A', holds: '', start: f.rowStarts[0]!, end: bytes.length }]);
    idx.file.size = bytes.length;
    await assert.rejects(readDomain(idx, 'reddit', fast(), true), /two gpt4 rows with the main setting/);
  } finally { await s.close(); }
});

test('flattening a post: bullets are not dashes, and a list keeps its sentences', () => {
  const machine = '## My Question\n\nI need help with these things:\n- flour and water\n- sugar, salt and butter\n- **Eggs:** two\n\n1. first step\n2) second step\n\nThanks in advance!';
  const flat = flatText(machine);
  assert.equal(flat, 'My Question. I need help with these things: flour and water. sugar, salt and butter. Eggs: two. first step. second step. Thanks in advance!');
  assert.equal(byId.get('em_dash')!.count!(flat), 0, 'no bullet became a dash');
  assert.equal(byId.get('bulleted_bold')!.test(flat), false);
  // the same text joined as it is would have counted the bullets as dashes
  assert.ok(byId.get('em_dash')!.count!(machine.replace(/\n+/g, ' ')) >= 2, 'or this test shows nothing');
  // each item is still a sentence of its own
  assert.deepEqual(sentences(flat), ['My Question.', 'I need help with these things: flour and water.', 'sugar, salt and butter.', 'Eggs: two.', 'first step.', 'second step.', 'Thanks in advance!']);
  // a human post already on one line is left as it is, spaced dashes and all
  const human = 'So I went there - and it was closed. Anyway,   what now?';
  assert.equal(flatText(human), 'So I went there - and it was closed. Anyway, what now?');
  assert.equal(byId.get('em_dash')!.count!(flatText(human)), 1);
  // a single line break is joined as a wrap, a paragraph that did not end a sentence gets its stop
  assert.equal(flatText('One line\nwithout a stop'), 'One line without a stop');
  assert.equal(flatText('One paragraph\n\nAnother'), 'One paragraph. Another');
  assert.equal(flatText('Ends on a quote."\n\nNext'), 'Ends on a quote." Next');
});

test('flattening a post: the dashes people type on Reddit count once, a suspended compound does not', () => {
  const dashes = (t: string): number => byId.get('em_dash')!.count!(flatText(t));
  // written for the test in the shapes the people's posts have
  assert.equal(flatText('we tried every season- nothing worked'), 'we tried every season - nothing worked');
  assert.equal(dashes('we tried every season- nothing worked'), 1);
  assert.equal(dashes('I asked my friends- i got no answer'), 1);
  assert.equal(dashes('it was fine--until it was not'), 1);
  assert.equal(dashes('a real one—and then'), 1, 'an em dash was already counted');
  for (const t of ['two- and three-year plans', 'pre- or post-war', 'long- to short-term', 'first- through third-grade', 'well-known, self-made', 'a 12- to 15-year range', 'x- y']) {
    assert.equal(dashes(t), 0, t);
  }
  // the dash counted in the post is the same one whoever typed it
  assert.equal(dashes('Model text - with a spaced hyphen'), 1);
  // the abstracts are not read through flatText: a TeX range and a wrapped hyphen stay uncounted there
  for (const t of ['the Calabi--Yau case', 'pages 10--20', 'a well- known result']) {
    assert.equal(byId.get('em_dash')!.count!(generationText({ generation: t })), 0, t);
  }
});

test('flattening a post: a post in quotation marks as a whole is unwrapped, two quoted spans are not', () => {
  assert.equal(unquoted('"I can\'t believe it. My cat said "hi" to me."'), 'I can\'t believe it. My cat said "hi" to me.');
  assert.equal(unquoted('  “A whole post, “quoted” inside.”\n'), 'A whole post, “quoted” inside.');
  assert.equal(unquoted('"Yes" and "no" are both answers'), '"Yes" and "no" are both answers');
  assert.equal(unquoted('"Yes" and "no"'), '"Yes" and "no"');
  assert.equal(unquoted('“One” and “two”'), '“One” and “two”');
  assert.equal(unquoted('No quotes at all'), 'No quotes at all');
  // the belief markers skip quoted spans, so a wrapped post hid its contraction
  const wrapped = '"I don\'t think this is right, and I have tried everything I know."';
  assert.equal(byId.get('no_contraction')!.test(wrapped), true, 'or this test shows nothing');
  assert.equal(byId.get('no_contraction')!.test(flatText(wrapped)), false);
});

test('a genre keeps only the documents every writer has, at 400 characters of prose, in human order', () => {
  const long = (s: string): string => `${s} ${'text '.repeat(90)}`;
  const rows = [
    { source_id: 'd2', model: 'human', generation: long('h2') },
    { source_id: 'd1', model: 'human', generation: long('h1') },
    { source_id: 'd3', model: 'human', generation: long('h3') },
    ...['chatgpt', 'gpt4', 'llama-chat', 'mistral-chat'].flatMap((m) => [
      { source_id: 'd1', model: m, generation: long(`${m}1`) },
      { source_id: 'd2', model: m, generation: long(`${m}2`) },
      // d3 is too short for one writer
      { source_id: 'd3', model: m, generation: m === 'gpt4' ? 'short' : long(`${m}3`) },
    ]),
    { source_id: 'd1', model: 'mpt', generation: long('x') },
  ];
  const { arms, kept, passed } = genreArms(rows, (g) => g);
  assert.deepEqual(Object.keys(arms), ['human', 'chatgpt', 'gpt4', 'llama-chat', 'mistral-chat']);
  assert.deepEqual(arms.human!.map((t) => t.id), ['raid:human:d2', 'raid:human:d1']);
  assert.deepEqual(arms.gpt4!.map((t) => t.id), ['raid:gpt4:d2', 'raid:gpt4:d1']);
  assert.ok(arms['llama-chat']![1]!.text.startsWith('llama-chat1'));
  assert.equal(kept.gpt4, 3);
  assert.equal(passed.gpt4, 2);
  assert.equal(kept.mpt, undefined);
});

// ---- the collector's cache, as the weekly job meets it

test('rows for a domain: a matching cache is used, a changed host is an error, a silent one is not', async () => {
  const f = raidFile(12);
  const s = await serve(rangeServer(f.bytes));
  const dir = mkdtempSync(path.join(tmpdir(), 'raid-cache-'));
  const cacheFile = path.join(dir, 'cache', 'reddit.json');
  const windowsFile = path.join(dir, 'raid-windows.json');
  const quiet = (): Host => new Host({ minGapMs: 0, backoffMs: 5, retries: 0, log: () => {} });
  try {
    const bare = indexFor(s.url, f, [{ name: 'A', holds: '', start: f.rowStarts[0]!, end: f.bytes.length }]);
    // the one run that records the counts writes them into the index file and fills the cache
    const recorded = await rowsFor(bare, 'reddit', { cacheFile, windowsFile, record: true, host: quiet(), log: () => {} });
    assert.equal(recorded.from, 'host');
    const index = JSON.parse(readFileSync(windowsFile, 'utf8')) as WindowsIndex;
    assert.equal(index.domains.reddit!.windows[0]!.rows, 12);
    assert.equal(index.domains.reddit!.windows[0]!.name, 'A');
    // the person's rows keep their title, the models' do not, and the titles follow the arms' order
    assert.equal(recorded.data.rows.find((r) => r.model === 'human')!.title, 'Title 0');
    assert.equal(recorded.data.rows.find((r) => r.model === 'gpt4')!.title, undefined);
    assert.deepEqual(titlesOf(recorded.data.rows, ['doc-1', 'doc-0', 'doc-9']), [
      { source_id: 'doc-1', title: 'Title 6' }, { source_id: 'doc-0', title: 'Title 0' }, { source_id: 'doc-9', title: '' },
    ]);

    const before = s.requests.length;
    const hit = await rowsFor(index, 'reddit', { cacheFile, windowsFile, host: quiet(), log: () => {} });
    assert.equal(hit.from, 'cache');
    assert.deepEqual(hit.data.rows, recorded.data.rows);
    assert.deepEqual(s.requests.slice(before).map((r) => r.method), ['HEAD'], 'a warm week costs one HEAD request');
  } finally { await s.close(); }

  // the host now serves another file: the cache is not used to hide that
  const changed = await serve(rangeServer(f.bytes, '"changed-2"'));
  try {
    const index = JSON.parse(readFileSync(windowsFile, 'utf8')) as WindowsIndex;
    index.file.url = changed.url;
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
    writeFileSync(cacheFile, JSON.stringify({ ...cached, file: { ...cached.file, url: changed.url } }));
    await assert.rejects(rowsFor(index, 'reddit', { cacheFile, windowsFile, host: quiet(), log: () => {} }), (e: Error) => e instanceof RaidSourceError && /measured again/.test(e.message));
  } finally { await changed.close(); }

  // nobody answers at that address any more: the cached rows are used, and the reason is logged
  const index = JSON.parse(readFileSync(windowsFile, 'utf8')) as WindowsIndex;
  index.file.url = JSON.parse(readFileSync(cacheFile, 'utf8')).file.url;
  const lines: string[] = [];
  const offline = await rowsFor(index, 'reddit', { cacheFile, windowsFile, host: quiet(), log: (l) => lines.push(l) });
  assert.equal(offline.from, 'cache');
  assert.ok(lines.some((l) => /could not reach .*using the cached rows/.test(l)), lines.join('\n'));
  rmSync(dir, { recursive: true, force: true });
});

test('rows for a domain: a cache from another file, or one that cannot be read, is read again and replaced', async () => {
  const f = raidFile(12);
  const s = await serve(rangeServer(f.bytes));
  const dir = mkdtempSync(path.join(tmpdir(), 'raid-cache-'));
  const cacheFile = path.join(dir, 'reddit.json');
  const windowsFile = path.join(dir, 'raid-windows.json');
  try {
    const first = await readDomain(indexFor(s.url, f, [{ name: 'A', holds: '', start: f.rowStarts[0]!, end: f.bytes.length }]), 'reddit', fast(), true);
    const index = indexFor(s.url, f, [{ name: 'A', holds: '', ...first.windows[0]! }]);
    for (const stale of [
      JSON.stringify({ ...first, file: { ...first.file, etag: '"older"' } }),
      JSON.stringify({ ...first, format: first.format - 1 }),
      '{"rows": [',
      'null',
      JSON.stringify({ rows: [] }),
    ]) {
      writeFileSync(cacheFile, stale);
      const lines: string[] = [];
      const got = await rowsFor(index, 'reddit', { cacheFile, windowsFile, host: fast(), log: (l) => lines.push(l) });
      assert.equal(got.from, 'host', stale.slice(0, 30));
      assert.deepEqual(got.data.rows, first.rows);
      assert.ok(lines.some((l) => /reading again/.test(l)), lines.join('\n'));
      assert.equal(cacheMatches(readCache(cacheFile)!, index, 'reddit'), true, 'the cache was replaced');
    }
    assert.equal(readCache(path.join(dir, 'missing.json')), null);
    assert.equal(existsSync(windowsFile), false, 'only a recording run writes the index');
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('range read: more bytes than asked for end the read; a body that keeps breaking is given up', async () => {
  const f = raidFile(12);
  const win = { start: f.rowStarts[1]!, end: f.rowStarts[4]! };
  // no Content-Length, so nothing but the reader can notice the extra bytes
  const over = await serve((req, res) => {
    res.writeHead(206, { etag: ETAG, 'content-range': `bytes ${win.start}-${win.end - 1}/${f.bytes.length}` });
    res.end(f.bytes.subarray(win.start, win.end + 50));
  });
  try {
    const file: SourceFile = { url: over.url, etag: ETAG, size: f.bytes.length };
    await assert.rejects(readWindow(file, win, () => {}, fast()), (e: Error) => e instanceof RaidSourceError && /sent more than the \d+ bytes asked for/.test(e.message));
  } finally { await over.close(); }

  // every answer stops after a few bytes: the read resumes `retries` times, then gives up
  const broken = await serve(async (req, res) => {
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')!;
    const a = Number(m[1]), b = Number(m[2]);
    res.writeHead(206, { etag: ETAG, 'content-length': b - a + 1, 'content-range': `bytes ${a}-${b}/${f.bytes.length}` });
    res.write(f.bytes.subarray(a, a + 10));
    await new Promise((r) => setTimeout(r, 50));
    res.socket!.destroy();
  });
  try {
    const file: SourceFile = { url: broken.url, etag: ETAG, size: f.bytes.length };
    await assert.rejects(readWindow(file, win, () => {}, fast()), /gave up on bytes .* after 3 resumed reads/);
    assert.equal(broken.requests.length, 4, 'the first request and three resumptions');
  } finally { await broken.close(); }
});

test('range read: a body that stalls is resumed after the idle timeout, not the runtime one', async () => {
  const f = raidFile(12);
  const win = { start: f.rowStarts[1]!, end: f.rowStarts[6]! };
  const proper = rangeServer(f.bytes);
  const s = await serve(async (req, res, n) => {
    if (n > 1) return proper(req, res, n);
    // two whole rows, then nothing, with the connection left open
    res.writeHead(206, { etag: ETAG, 'content-length': win.end - win.start, 'content-range': `bytes ${win.start}-${win.end - 1}/${f.bytes.length}` });
    res.write(f.bytes.subarray(win.start, f.rowStarts[3]!));
  });
  try {
    const file: SourceFile = { url: s.url, etag: ETAG, size: f.bytes.length };
    const lines: string[] = [];
    const host = new Host({ minGapMs: 0, backoffMs: 5, retries: 3, idleTimeoutMs: 150, log: (l) => lines.push(l) });
    const started = Date.now();
    const got: string[] = [];
    const read = await readWindow(file, win, (fields) => got.push(fields[0]!), host);
    assert.ok(Date.now() - started < 5000);
    assert.deepEqual(got, f.rows.slice(1, 6).map((r) => r[0]), 'every row once');
    assert.equal(read.resumed, 1);
    assert.ok(lines.some((l) => /no bytes for 0\.15 s; resuming at byte/.test(l)), lines.join('\n'));
    assert.equal(s.requests[1]!.range, `bytes=${f.rowStarts[3]}-${win.end - 1}`);
  } finally { await s.close(); }
});

test('a request whose headers never come is retried after the headers timeout', async () => {
  let n = 0;
  const s = await serve((req, res) => {
    n++;
    if (n === 1) return;   // never answers
    res.writeHead(200, { etag: ETAG, 'content-length': 10 });
    res.end();
  });
  try {
    const lines: string[] = [];
    const host = new Host({ minGapMs: 0, backoffMs: 5, retries: 2, headersTimeoutMs: 150, log: (l) => lines.push(l) });
    await checkSource({ url: s.url, etag: ETAG, size: 10 }, host);
    assert.equal(n, 2);
    assert.ok(lines.some((l) => /within 0\.15 s|abort/i.test(l)), lines.join('\n'));
  } finally { await s.close(); }
});
