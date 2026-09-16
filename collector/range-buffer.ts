/**
 * A parquet source that reads over HTTP range requests, paced and retried.
 *
 * hyparquet takes any object with a byteLength and a slice; its own URL reader issues requests as
 * fast as it can, and the host answers 429 within a few hundred of them. This one keeps a minimum
 * gap between requests and backs off when asked to, which is what lets a 2.3 GB dataset be read
 * from a free runner without downloading it.
 */

export interface AsyncBuffer {
  byteLength: number;
  slice(start: number, end?: number): Promise<ArrayBuffer>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RangeOptions {
  /** smallest gap between two requests */
  minGapMs?: number;
  /** how many times to retry a 429 or a 5xx before giving up */
  retries?: number;
  userAgent?: string;
}

export async function rangeBuffer(url: string, opts: RangeOptions = {}): Promise<AsyncBuffer> {
  const minGap = opts.minGapMs ?? 250;
  const retries = opts.retries ?? 6;
  const headers: Record<string, string> = { 'user-agent': opts.userAgent ?? 'is-it-really-an-ai-tell/0.1 (+https://github.com/barbarkaragul-oss/is-it-really-an-ai-tell)' };
  let last = 0;

  async function paced(init: RequestInit & { headers?: Record<string, string> }, target: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const wait = Math.max(0, last + minGap - Date.now());
      if (wait) await sleep(wait);
      last = Date.now();
      let r: Response;
      try {
        r = await fetch(target, init);
      } catch (e) {
        if (attempt >= retries) throw e;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (r.ok) return r;
      const retryable = r.status === 429 || r.status >= 500;
      if (!retryable || attempt >= retries) throw new Error(`${r.status} ${r.statusText} for ${target.slice(0, 90)}`);
      // honour Retry-After when the host sends one, otherwise double the wait
      const after = Number(r.headers.get('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt);
    }
  }

  const head = await paced({ method: 'HEAD', headers, redirect: 'follow' }, url);
  const byteLength = Number(head.headers.get('content-length'));
  if (!Number.isFinite(byteLength) || byteLength <= 0) throw new Error(`no content-length for ${url}`);
  const resolved = head.url || url;

  return {
    byteLength,
    async slice(start: number, end?: number): Promise<ArrayBuffer> {
      const to = (end ?? byteLength) - 1;
      const r = await paced({ headers: { ...headers, range: `bytes=${start}-${to}` }, redirect: 'follow' }, resolved);
      return r.arrayBuffer();
    },
  };
}
