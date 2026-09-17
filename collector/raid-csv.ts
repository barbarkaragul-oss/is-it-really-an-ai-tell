/**
 * RAID's unattacked rows, read from its published CSV in byte windows.
 *
 * Hugging Face's parquet copy of RAID is a partial conversion: it stops inside poetry, so Reddit
 * posts, film reviews and encyclopedia intros are not in it. RAID also publishes the unattacked rows
 * alone as one 802 MB CSV (https://dataset.raid-bench.xyz/train_none.csv, linked from
 * https://github.com/liamdugan/raid). Its rows are grouped by domain, and inside a domain the
 * writers this project measures sit in two stretches: the first pass (the human text and the open
 * models) and the block of API models. collector/raid-windows.json records those two byte windows per
 * domain, measured once from a full pass, so a genre costs two range requests instead of the file.
 *
 * The windows are only right for one version of the file, so the file's ETag and size are pinned
 * there too, and every response must carry them. A server that ignores the Range header would answer
 * 200 with the whole file: that answer is refused before its body is read, and asked again a few
 * times, since RAID's host does this now and then. A body that breaks off is resumed from the end of
 * the last complete row, never restarted and never half-used.
 *
 * The parser is RFC 4180 as Python's csv module writes it: a field is quoted when it holds a comma,
 * a quote or a line break, a quote inside it is doubled, and rows end in LF (CRLF is accepted). It is
 * strict: a stray quote or a row with the wrong number of fields is an error rather than a guess,
 * which is also what catches a window that does not start on a row boundary.
 */

export const USER_AGENT = 'is-it-really-an-ai-tell/0.1 (+https://github.com/barbarkaragul-oss/is-it-really-an-ai-tell)';

/**
 * The version of the rows this module keeps. Raise it when the filter or what a kept row holds
 * changes, so caches are not reused. The weekly job also keys its cache on this file, so any change
 * here starts a fresh read. 2: a person's row keeps its title (collector/fetch-raid.ts, KeptRow).
 */
export const ROW_FORMAT = 2;

/** the writers every CSV genre keeps, by RAID's model names, the person first */
export const RAID_WRITERS = ['human', 'chatgpt', 'gpt4', 'llama-chat', 'mistral-chat'] as const;

const QUOTE = 0x22, COMMA = 0x2c, LF = 0x0a, CR = 0x0d;
/** where the parser is: at a field's start, inside an unquoted or a quoted field, just after a quote inside one, or after a CR */
const S = { FieldStart: 0, Unquoted: 1, Quoted: 2, QuoteInQuoted: 3, AfterCR: 4 } as const;
type State = (typeof S)[keyof typeof S];

/** Malformed CSV, or a response that is not the bytes asked for: retrying would not help. */
export class RaidSourceError extends Error {
  override name = 'RaidSourceError';
}

export type RowHandler = (fields: string[], start: number, end: number) => void;

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Splits a byte stream into CSV rows, reporting each row with its absolute byte span [start, end).
 * The span is what makes a broken download resumable: `complete` is the offset just past the last
 * row handed out, and a new request from there loses and repeats nothing.
 * Fields are decoded only once their row is complete, so a character split across two chunks is
 * never decoded in halves.
 */
export class CsvRows {
  private buf = new Uint8Array(0);
  /** the next byte of buf to look at; bytes before it belong to the incomplete row and are already read */
  private scan = 0;
  private state: State = S.FieldStart;
  /** where the incomplete row's fields end, as offsets into buf */
  private cuts: number[] = [];
  private base: number;
  rows = 0;

  constructor(start: number, private readonly onRow: RowHandler) {
    this.base = start;
  }

  /** absolute offset just past the last complete row */
  get complete(): number { return this.base; }

  push(chunk: Uint8Array): void {
    let buf: Uint8Array;
    if (this.buf.length) {
      buf = new Uint8Array(this.buf.length + chunk.length);
      buf.set(this.buf);
      buf.set(chunk, this.buf.length);
    } else {
      buf = chunk;
    }
    let state: State = this.state, rowStart = 0, i = this.scan;
    const cuts = this.cuts;
    const fail = (what: string): never => {
      throw new RaidSourceError(`malformed CSV at byte ${this.base + i}: ${what}`);
    };
    const endRow = (end: number): void => {
      const fields: string[] = [];
      let a = rowStart;
      for (const z of cuts) {
        fields.push(decodeField(buf, a, z));
        a = z + 1;
      }
      cuts.length = 0;
      this.rows++;
      // the callback may throw (a row that should not be here); nothing after it is consumed
      this.onRow(fields, this.base + rowStart, this.base + end);
      rowStart = end;
    };
    for (; i < buf.length; i++) {
      const b = buf[i]!;
      switch (state) {
        case S.Quoted: {
          // generations are long and quotes in them rare: jump to the next one
          const q = buf.indexOf(QUOTE, i);
          if (q < 0) { i = buf.length - 1; break; }   // the loop's i++ leaves i at the end
          i = q;
          state = S.QuoteInQuoted;
          break;
        }
        case S.QuoteInQuoted:
          if (b === QUOTE) { state = S.Quoted; break; }
          // the quote closed the field; what follows must end it
          if (b === COMMA) { cuts.push(i); state = S.FieldStart; } else if (b === LF) { cuts.push(i); endRow(i + 1); state = S.FieldStart; } else if (b === CR) { cuts.push(i); state = S.AfterCR; } else fail('text after a closing quote');
          break;
        case S.AfterCR:
          if (b !== LF) fail('a carriage return outside quotes that does not end the row');
          endRow(i + 1);
          state = S.FieldStart;
          break;
        case S.FieldStart:
          if (b === QUOTE) { state = S.Quoted; break; }
          state = S.Unquoted;
        // falls through: the byte is the field's first
        case S.Unquoted:
          if (b === COMMA) { cuts.push(i); state = S.FieldStart; } else if (b === LF) { cuts.push(i); endRow(i + 1); state = S.FieldStart; } else if (b === CR) { cuts.push(i); state = S.AfterCR; } else if (b === QUOTE) fail('a quote inside an unquoted field');
          break;
      }
    }
    // keep only the incomplete row, with its field ends moved to the new buffer's origin
    for (let k = 0; k < cuts.length; k++) cuts[k] = cuts[k]! - rowStart;
    // a copy, so the stream's chunk is not held on to; it is at most one row
    this.buf = buf.slice(rowStart);
    this.scan = i - rowStart;
    this.state = state;
    this.base += rowStart;
  }

  /** The stream is over: a row still open means the bytes did not end where a row does. */
  finish(): void {
    if (this.buf.length) throw new RaidSourceError(`the bytes end inside a row that starts at ${this.base} (${this.buf.length} bytes held)`);
  }

  /** Forget the incomplete row and continue from `complete`, as after a broken download. */
  resume(): void {
    this.buf = new Uint8Array(0);
    this.scan = 0;
    this.state = S.FieldStart;
    this.cuts.length = 0;
  }
}

function decodeField(buf: Uint8Array, a: number, z: number): string {
  if (z > a && buf[z - 1] === CR) z--;
  try {
    if (buf[a] === QUOTE) {
      const s = utf8.decode(buf.subarray(a + 1, z - 1));
      return s.includes('"') ? s.replaceAll('""', '"') : s;
    }
    return utf8.decode(buf.subarray(a, z));
  } catch {
    throw new RaidSourceError(`a field at buffer offset ${a} is not valid UTF-8`);
  }
}

// ---- the HTTP side

export interface SourceFile {
  url: string;
  /** as the server sends it, quotes included */
  etag: string;
  size: number;
}

export interface Window {
  /** first byte, the start of a row */
  start: number;
  /** one past the last byte, the end of a row */
  end: number;
}

export interface ReadOptions {
  fetch?: typeof fetch;
  /** smallest gap between two requests to the host */
  minGapMs?: number;
  /** how many times to retry a refused or broken request before giving up */
  retries?: number;
  /** the first wait before a retry; it doubles each time */
  backoffMs?: number;
  /**
   * How long to wait for an answer's headers, and for the next bytes of a body, before treating the
   * request as broken. Without them a stalled connection waits for the runtime's own five minutes,
   * and a few of those outlast the weekly job, which is then cancelled without saying why.
   */
  headersTimeoutMs?: number;
  idleTimeoutMs?: number;
  log?: (line: string) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A weak validator ("W/") names the same bytes for our purpose; compare the tag itself. */
export const sameEtag = (a: string | null | undefined, b: string): boolean =>
  a != null && a.trim().replace(/^W\//, '') === b.trim().replace(/^W\//, '');

/**
 * One connection's worth of politeness: requests go one after another with a gap between them, and
 * a 429 or a 5xx waits (Retry-After when the host gives one) before trying again.
 */
export class Host {
  private last = 0;
  readonly fetch: typeof fetch;
  readonly minGap: number;
  readonly retries: number;
  readonly backoff: number;
  readonly headersTimeout: number;
  readonly idleTimeout: number;
  readonly log: (line: string) => void;

  constructor(opts: ReadOptions = {}) {
    this.fetch = opts.fetch ?? fetch;
    this.minGap = opts.minGapMs ?? 1000;
    this.retries = opts.retries ?? 5;
    this.backoff = opts.backoffMs ?? 2000;
    this.headersTimeout = opts.headersTimeoutMs ?? 60_000;
    this.idleTimeout = opts.idleTimeoutMs ?? 60_000;
    this.log = opts.log ?? ((line) => console.error(line));
  }

  async request(url: string, init: RequestInit & { headers: Record<string, string> }): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const wait = Math.max(0, this.last + this.minGap - Date.now());
      if (wait) await sleep(wait);
      this.last = Date.now();
      let r: Response;
      // the timer covers the headers only: it is cleared once they arrive, so a long body is not cut
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(new Error(`no answer from the host within ${this.headersTimeout / 1000} s`)), this.headersTimeout);
      try {
        r = await this.fetch(url, { ...init, signal: abort.signal, redirect: 'follow', headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'identity', ...init.headers } });
      } catch (e) {
        if (attempt >= this.retries) throw e;
        this.log(`    ${(e as Error).message}; retrying`);
        await sleep(this.backoff * 2 ** attempt);
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (r.status !== 429 && r.status < 500) return r;
      await r.body?.cancel().catch(() => {});
      if (attempt >= this.retries) throw new Error(`${r.status} ${r.statusText} from ${url}`);
      const after = Number(r.headers.get('retry-after'));
      this.log(`    ${r.status} from the host; waiting`);
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : this.backoff * 2 ** attempt);
    }
  }
}

/** The file on the server must still be the one the windows were measured on. */
export async function checkSource(file: SourceFile, host: Host): Promise<void> {
  const r = await host.request(file.url, { method: 'HEAD', headers: {} });
  if (r.status !== 200) throw new RaidSourceError(`HEAD ${file.url} answered ${r.status}`);
  const etag = r.headers.get('etag'), size = Number(r.headers.get('content-length'));
  if (!sameEtag(etag, file.etag) || size !== file.size) {
    throw new RaidSourceError(
      `${file.url} is not the version the byte windows were measured on: ETag ${etag} and ${size} bytes, expected ${file.etag} and ${file.size}. ` +
      'The windows in collector/raid-windows.json have to be measured again for the new file.',
    );
  }
}

/**
 * Why a response is not exactly the bytes asked for, or null when it is. Anything but a 206 whose
 * Content-Range is the requested span of the pinned file is refused, and so is a compressed body,
 * whose length and offsets would not be the file's.
 */
export function refuseRange(r: Response, file: SourceFile, from: number, to: number): string | null {
  if (r.status !== 206) return `the host answered ${r.status} instead of 206 to a range request`;
  const range = r.headers.get('content-range');
  if (range !== `bytes ${from}-${to}/${file.size}`) return `Content-Range is "${range}", expected "bytes ${from}-${to}/${file.size}"`;
  if (!sameEtag(r.headers.get('etag'), file.etag)) return `ETag is ${r.headers.get('etag')}, expected ${file.etag}; the file changed`;
  const enc = r.headers.get('content-encoding');
  if (enc && enc !== 'identity') return `the body is ${enc}-encoded`;
  const len = r.headers.get('content-length');
  if (len !== null && Number(len) !== to - from + 1) return `Content-Length is ${len}, expected ${to - from + 1}`;
  return null;
}

export interface WindowRead {
  rows: number;
  bytes: number;
  requests: number;
  /** how many times a broken body was picked up again */
  resumed: number;
}

/**
 * Stream one window through the CSV parser. A body that fails, ends early or sends nothing for the
 * host's idle timeout is requested again from the end of the last complete row, up to `retries`
 * times; the rows before that point were already handed out and are not repeated. An error thrown by
 * onRow, a malformed row, or more bytes than were asked for ends the read.
 */
export async function readWindow(file: SourceFile, win: Window, onRow: RowHandler, host: Host): Promise<WindowRead> {
  if (!(win.start >= 0 && win.end > win.start && win.end <= file.size)) throw new RaidSourceError(`bad window ${win.start}-${win.end}`);
  const rows = new CsvRows(win.start, onRow);
  let from = win.start, requests = 0, resumed = 0, ignored = 0;
  while (from < win.end) {
    const to = win.end - 1;
    const r = await host.request(file.url, { headers: { range: `bytes=${from}-${to}` } });
    requests++;
    const refused = refuseRange(r, file, from, to);
    if (refused) {
      // cancelling drops the connection, so a 200 carrying the whole file is never read
      await r.body?.cancel().catch(() => {});
      // RAID's host (behind Cloudflare) now and then answers a range request with the whole file, and
      // answers the same request properly a moment later: a 200 for the pinned file is asked again,
      // a few times. Any other refusal, a changed file above all, is final.
      if (r.status === 200 && sameEtag(r.headers.get('etag'), file.etag) && ignored < host.retries) {
        ignored++;
        host.log(`    the host ignored the range and offered the whole file; asking again (${ignored} of ${host.retries})`);
        await sleep(host.backoff * 2 ** (ignored - 1));
        continue;
      }
      throw new RaidSourceError(`${refused} (bytes ${from}-${to} of ${file.url})`);
    }
    const expected = to - from + 1;
    let got = 0, broke: string | null = null;
    const reader = r.body!.getReader();
    try {
      for (;;) {
        let part: ReadableStreamReadResult<Uint8Array> | 'idle';
        let idle: ReturnType<typeof setTimeout> | undefined;
        try {
          part = await Promise.race([
            reader.read(),
            new Promise<'idle'>((r) => { idle = setTimeout(() => r('idle'), host.idleTimeout); }),
          ]);
        } catch (e) {
          broke = (e as Error).message || String(e);
          break;
        } finally {
          clearTimeout(idle);
        }
        if (part === 'idle') { broke = `no bytes for ${host.idleTimeout / 1000} s`; break; }
        if (part.done) break;
        got += part.value.length;
        if (got > expected) throw new RaidSourceError(`the host sent more than the ${expected} bytes asked for`);
        rows.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (!broke && got < expected) broke = `the body ended after ${got} of ${expected} bytes`;
    if (!broke) {
      rows.finish();
      from = win.end;
      break;
    }
    if (resumed >= host.retries) throw new Error(`gave up on bytes ${win.start}-${win.end} after ${resumed} resumed reads: ${broke}`);
    resumed++;
    rows.resume();
    from = rows.complete;
    host.log(`    ${broke}; resuming at byte ${from} (${from - win.start} of ${win.end - win.start} read)`);
    await sleep(host.backoff * 2 ** (resumed - 1));
  }
  return { rows: rows.rows, bytes: win.end - win.start, requests, resumed };
}

// ---- RAID's rows

export const RAID_COLUMNS = ['id', 'adv_source_id', 'source_id', 'model', 'decoding', 'repetition_penalty', 'attack', 'domain', 'title', 'prompt', 'generation'] as const;
export type RaidCsvRow = Record<(typeof RAID_COLUMNS)[number], string>;

/** The row as named fields; the column order comes from the pinned file, not from a header request. */
export function namedRow(fields: string[], columns: readonly string[]): RaidCsvRow {
  if (fields.length !== columns.length) throw new RaidSourceError(`a row has ${fields.length} fields, the file has ${columns.length} columns`);
  const row = {} as Record<string, string>;
  columns.forEach((c, i) => { row[c] = fields[i]!; });
  for (const c of RAID_COLUMNS) if (!(c in row)) throw new RaidSourceError(`the file has no "${c}" column`);
  return row as RaidCsvRow;
}

/**
 * The one generation setting every machine arm is measured on: greedy decoding without a repetition
 * penalty. RAID has each model write every document several ways (the API models greedy and
 * sampled, the open models also with and without a penalty), and today's arms were greedy only
 * because that row happens to come first in the file. The filter says so instead of relying on it.
 * Greedy decoding is also the only setting all four models share with the published results.
 */
export const MAIN_SETTING = { decoding: 'greedy', repetition_penalty: 'no' } as const;

/**
 * Whether a row was written with the main setting. A human row has no setting at all, and one that
 * claims a setting is not the human text this project means, so it is left out too.
 */
export function hasMainSetting(row: Pick<RaidCsvRow, 'model' | 'decoding' | 'repetition_penalty'>): boolean {
  if (row.model === 'human') return row.decoding === '' && row.repetition_penalty === '';
  return row.decoding === MAIN_SETTING.decoding && row.repetition_penalty === MAIN_SETTING.repetition_penalty;
}

/** Whether a row belongs in a measured arm: unattacked, in the domain, by a wanted writer, with the main setting. */
export function isMeasuredRow(row: Pick<RaidCsvRow, 'model' | 'decoding' | 'repetition_penalty' | 'attack' | 'domain'>, domain: string, writers: ReadonlySet<string>): boolean {
  return row.attack === 'none' && row.domain === domain && writers.has(row.model) && hasMainSetting(row);
}
