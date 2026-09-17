import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseAtom, parseOai, normTitle, titleTerms, abstractPhrase, overlap, titleSimilarity, pickMatch,
  decide, lookup, searchesFor, politeClient, serialize, readDates, decodeXml, isoDay, MIN_GAP_MS,
  TransientError, isDated, skippedRow, countRows, nearMisses,
  type Http, type Entry, type DateRow,
} from '../scripts/arxiv-dates.js';

// Fixtures are written by hand in the shape arXiv answers in (checked against live answers on
// 2026-09-17); their titles and abstracts are invented.

const ATOM = String.raw`<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
  <id>https://arxiv.org/api/abc</id>
  <title>arXiv Query: search_query=ti:toric&amp;id_list=&amp;start=0&amp;max_results=10</title>
  <updated>2026-09-17T08:08:06Z</updated>
  <opensearch:itemsPerPage>10</opensearch:itemsPerPage>
  <opensearch:totalResults>2</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/1202.0001v4</id>
    <title>Toric K\"ahler metrics &amp; the
  fourth version&#39;s title</title>
    <updated>2023-07-25T07:21:25Z</updated>
    <link href="https://arxiv.org/abs/1202.0001v4" rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/1202.0001v4" rel="related" type="application/pdf" title="pdf"/>
    <summary>  We study metrics &lt;on&gt; toric
  varieties.</summary>
    <category term="math.DG" scheme="http://arxiv.org/schemas/atom"/>
    <published>2012-02-16T23:59:59Z</published>
    <arxiv:primary_category term="math.DG"/>
    <author>
      <name>A. Person</name>
    </author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/math/0211159v1</id>
    <title>An old-style identifier</title>
    <updated>2002-11-11T10:00:00Z</updated>
    <summary>Short.</summary>
    <published>2002-11-11T10:00:00Z</published>
  </entry>
</feed>`;

const EMPTY_ATOM = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>arXiv Query: search_query=ti:nothing</title>
  <opensearch:totalResults>0</opensearch:totalResults>
</feed>`;

const ERROR_ATOM = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>https://arxiv.org/</id>
  <title>arXiv Search Results</title>
  <entry>
    <id>https://arxiv.org/api/errors</id>
    <title>Error</title>
    <summary>Invalid query string: '('</summary>
  </entry>
</feed>`;

const OAI_RECORD = String.raw`<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/">
  <responseDate>2026-09-17T08:04:18Z</responseDate>
  <request verb="GetRecord" identifier="oai:arXiv.org:1202.0001" metadataPrefix="arXivRaw">http://oaipmh.arxiv.org/oai</request>
  <GetRecord>
    <record>
      <header><identifier>oai:arXiv.org:1202.0001</identifier><datestamp>2023-07-26</datestamp></header>
      <metadata>
        <arXivRaw xmlns="http://arxiv.org/OAI/arXivRaw/">
          <id>1202.0001</id>
          <submitter>A. Person</submitter>
          <version version="v2">
            <date>Tue, 05 Jun 2012 16:49:46 GMT</date>
            <size>69kb</size>
          </version>
          <version version="v1">
            <date>Thu, 16 Feb 2012 23:13:16 GMT</date>
            <size>22kb</size>
          </version>
          <version version="v10">
            <date>Tue, 25 Jul 2023 07:21:25 GMT</date>
            <size>95kb</size>
          </version>
          <version version="v3">
            <date>Sat, 16 Jun 2018 16:00:41 GMT</date>
            <size>73kb</size>
          </version>
          <title>Toric K\&quot;ahler metrics &amp; the fourth version&#39;s title</title>
          <authors>A. Pers\&#39;on</authors>
          <abstract>We study metrics.</abstract>
        </arXivRaw>
      </metadata>
    </record>
  </GetRecord>
</OAI-PMH>`;

const OAI_MISSING = `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/">
    <request>http://oaipmh.arxiv.org/oai</request>
    <error code='idDoesNotExist'>The value of the identifier argument is unknown or illegal in this repository.</error>
</OAI-PMH>`;

test('parseAtom: ids of both styles, versions, days, entities and wrapped titles', () => {
  const [a, b, ...rest] = parseAtom(ATOM);
  assert.equal(rest.length, 0, 'the feed header is not an entry');
  assert.deepEqual(a, {
    id: '1202.0001', version: 4, title: String.raw`Toric K\"ahler metrics & the fourth version's title`,
    summary: 'We study metrics <on> toric varieties.', published: '2012-02-16', updated: '2023-07-25',
  });
  assert.equal(b!.id, 'math/0211159');
  assert.equal(b!.version, 1);
  assert.deepEqual(parseAtom(EMPTY_ATOM), []);
});

test('parseAtom: an error feed or a page that is not a feed throws, so it is never read as "not found"', () => {
  assert.throws(() => parseAtom(ERROR_ATOM), /Invalid query string/);
  assert.throws(() => parseAtom('<html><body>Service unavailable</body></html>'), /not an Atom feed/);
});

test('parseOai: every version in order, as UTC days; a missing id is null; other errors throw', () => {
  const rec = parseOai(OAI_RECORD)!;
  assert.equal(rec.id, '1202.0001');
  assert.equal(rec.title, String.raw`Toric K\"ahler metrics & the fourth version's title`);
  assert.deepEqual(rec.versions, [
    { v: 1, date: '2012-02-16' }, { v: 2, date: '2012-06-05' }, { v: 3, date: '2018-06-16' }, { v: 10, date: '2023-07-25' },
  ]);
  assert.equal(parseOai(OAI_MISSING), null);
  assert.throws(() => parseOai(`<OAI-PMH><error code="badArgument">no</error></OAI-PMH>`), /badArgument/);
  assert.throws(() => parseOai(`<OAI-PMH><GetRecord></GetRecord></OAI-PMH>`), /no arXivRaw/);
  assert.throws(() => parseOai(`<OAI-PMH><arXivRaw><id>1</id><title>t</title></arXivRaw></OAI-PMH>`), /no versions/);
  assert.throws(() => parseOai(EMPTY_ATOM), /not OAI-PMH/);
});

test('decodeXml and isoDay', () => {
  assert.equal(decodeXml('&amp;lt; &#39; &#x2014; &quot;'), '&lt; \' — "');
  assert.equal(isoDay('Thu, 16 Feb 2012 23:13:16 GMT'), '2012-02-16');
  assert.equal(isoDay('2012-02-16T23:59:59Z'), '2012-02-16');
  assert.throws(() => isoDay('last Tuesday'), /not a date/);
  assert.throws(() => isoDay(undefined), /not a date/);
});

test('normTitle: TeX and Unicode accents, line wraps and quotes compare equal', () => {
  const want = 'toric kahler metrics seen from infinity';
  assert.equal(normTitle('Toric K\\"ahler metrics seen from\n  infinity'), want);
  assert.equal(normTitle('Toric Kähler metrics seen from infinity'), want);
  assert.equal(normTitle('Toric K{\\"a}hler Metrics Seen From Infinity'), want);
  assert.equal(normTitle("The Lov\\'asz-Softmax loss"), normTitle('The Lovász-Softmax loss'));
  assert.equal(normTitle("Me\\v{s}trovi\\'c"), 'mestrovic');
  assert.equal(normTitle('Meštrović and Ørsted'), 'mestrovic and orsted');
  assert.equal(normTitle("Maxwell’s equations"), normTitle("Maxwell's equations"));
  // a TeX command that starts with an accent letter is not an accent
  assert.equal(normTitle('The \\vec{v} and \\hat{h} fields'), 'the v and h fields');
});

test('titleTerms: no stop words, hyphens split, accented or TeX words left out, longest first', () => {
  const t = titleTerms('A Smoothed P-Value Test When There is a Nuisance Parameter under the\n  Alternative');
  assert.deepEqual(t, ['alternative', 'parameter', 'nuisance', 'smoothed', 'under', 'value', 'test', 'when']);
  assert.ok(!titleTerms('Track, then Decide').includes('then'), '"then" is a Lucene stop word and would match nothing');
  assert.deepEqual(titleTerms('The Lovász-Softmax loss: A tractable surrogate'), ['surrogate', 'tractable', 'softmax', 'loss']);
  assert.deepEqual(titleTerms('Toric K\\"ahler metrics'), ['metrics', 'toric']);
  assert.deepEqual(titleTerms("Maxwell's Equations (and GRAVITY)"), ['equations', 'gravity']);
  assert.deepEqual(titleTerms('Graphs, graphs and GRAPHS'), ['graphs']);
  assert.equal(titleTerms('one two three four five six seven eight nine ten', 4).length, 4);
  assert.deepEqual(titleTerms('$\\mathbb{R}^n$'), []);
});

test('abstractPhrase: the most specific run of plain words, never across punctuation or TeX', () => {
  const p = abstractPhrase('In this paper we propose a novel method for the stable recovery of sparse wavelet coefficients from noisy samples.');
  assert.ok(p, 'a long plain run gives a phrase');
  assert.equal(p!.split(' ').length, 8);
  assert.ok(!p!.startsWith('in this paper'), `a stock opening is not specific: ${p}`);
  assert.match(p!, /wavelet coefficients/);
  // the word before a comma belongs to the run, the word after it does not
  assert.equal(abstractPhrase('Consider the bounded harmonic extensions of eigenfunctions, which we prove exist.'), 'consider the bounded harmonic extensions of eigenfunctions');
  assert.equal(abstractPhrase('Let $G$ be a graph-theoretic object (MC-Net+) here.'), null);
  assert.equal(abstractPhrase('Too short to search.'), null);
  assert.equal(abstractPhrase('we show that it is in the paper and that it is'), null, 'only stop and stock words');
});

const ABSTRACT = 'We present a mutual consistency network that exploits the unlabeled hard regions of medical images, and we show that it outperforms every baseline on three public datasets while using far fewer annotations than earlier work.';
const REVISED = 'In this extended version we present a mutual consistency network that exploits the unlabeled hard regions of medical images, and we show that it outperforms eight baselines on four public datasets.';
const OTHER = 'A quantum walk on a hexagonal lattice is shown to localise when the coin operator is chosen at random, with a proof that covers every dimension above two.';

test('overlap and titleSimilarity', () => {
  assert.equal(overlap(ABSTRACT, ABSTRACT), 1);
  assert.equal(overlap(ABSTRACT, OTHER), 0);
  const r = overlap(ABSTRACT, REVISED);
  assert.ok(r > 0.4 && r < 0.9, `a revised abstract keeps much of the text: ${r}`);
  assert.equal(overlap('two words', ABSTRACT), 0);
  assert.equal(titleSimilarity('Mutual Consistency for Hard Regions', 'mutual consistency for hard regions'), 1);
  assert.equal(titleSimilarity('Graphs', 'Quantum walks'), 0);
});

const entry = (e: Partial<Entry> & { id: string; title: string }): Entry =>
  ({ version: 1, summary: '', published: '2020-01-01', updated: '2020-01-01', ...e });

test('pickMatch: the same title first, the closest abstract among equals, a new title only with the abstract', () => {
  const doc = { source_id: 's', title: 'Mutual Consistency for Hard Regions', human: ABSTRACT };
  const twin = entry({ id: 'twin', title: 'Mutual consistency for hard regions', summary: OTHER });
  const real = entry({ id: 'real', title: 'Mutual Consistency for Hard Regions', summary: REVISED });
  const renamed = entry({ id: 'renamed', title: 'Mutual Consistency Learning for Hard Regions in Medicine', summary: ABSTRACT });
  assert.equal(pickMatch(doc, [twin, real])!.entry.id, 'real');
  assert.equal(pickMatch(doc, [renamed, twin])!.entry.id, 'twin', 'an identical title beats a renamed one');
  const m = pickMatch(doc, [entry({ id: 'x', title: 'Graph colouring', summary: OTHER }), renamed])!;
  assert.deepEqual([m.entry.id, m.how, m.overlap], ['renamed', 'title+abstract', 1]);
  const moved = pickMatch(doc, [entry({ id: 'far', title: 'Semi-supervised learning in radiology', summary: ABSTRACT })])!;
  assert.equal(moved.how, 'abstract');
  // a similar title with an unrelated abstract is another paper
  assert.equal(pickMatch(doc, [entry({ id: 'y', title: 'Mutual Consistency for Hard Regions of Graphs', summary: OTHER })]), null);
  // without RAID's text a renamed paper cannot be confirmed
  assert.equal(pickMatch({ source_id: 's', title: doc.title }, [renamed]), null);
  assert.equal(pickMatch({ source_id: 's', title: doc.title }, [real])!.overlap, null);
});

test('decide: any version inside the window excludes; the window includes both ends', () => {
  assert.deepEqual(decide([{ v: 1, date: '2012-02-16' }, { v: 4, date: '2023-07-25' }]),
    { excluded: true, reason: 'v4 2023-07-25 posted between 2022-11-30 and 2024-06-04' });
  assert.equal(decide([{ v: 1, date: '2022-11-30' }]).excluded, true);
  assert.equal(decide([{ v: 1, date: '2024-06-04' }]).excluded, true);
  assert.deepEqual(decide([{ v: 1, date: '2022-11-29' }]), { excluded: false, reason: 'every version predates 2022-11-30' });
  // a version posted after RAID's file was built cannot be the text RAID holds
  assert.deepEqual(decide([{ v: 1, date: '2021-08-11' }, { v: 2, date: '2025-03-25' }]),
    { excluded: false, reason: 'no version between 2022-11-30 and 2024-06-04; v2 2025-03-25 came after RAID was built' });
  assert.equal(decide([{ v: 1, date: '2019-01-01' }, { v: 2, date: '2023-02-01' }, { v: 3, date: '2025-03-25' }]).excluded, true);
  assert.equal(decide([{ v: 1, date: '2020-01-01' }], { from: '2019-01-01', to: '2019-12-31' }).excluded, false);
  assert.throws(() => decide([]), /no versions/);
});

// --- lookup, against a fake arXiv ---

interface FakeEntry { id: string; v: number; title: string; summary?: string; published: string; updated?: string }
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const feed = (entries: FakeEntry[]): string => `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <opensearch:totalResults>${entries.length}</opensearch:totalResults>
${entries.map((e) => `  <entry><id>http://arxiv.org/abs/${e.id}v${e.v}</id><title>${esc(e.title)}</title><updated>${e.updated ?? e.published}T12:00:00Z</updated><summary>${esc(e.summary ?? '')}</summary><published>${e.published}T12:00:00Z</published></entry>`).join('\n')}
</feed>`;
const oai = (id: string, dates: string[]): string => `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><GetRecord><record><metadata><arXivRaw>
<id>${id}</id>${dates.map((d, i) => `<version version="v${i + 1}"><date>${new Date(`${d}T12:00:00Z`).toUTCString()}</date><size>1kb</size></version>`).join('')}
<title>t</title></arXivRaw></metadata></record></GetRecord></OAI-PMH>`;

interface Route { and?: string; or?: string; phrase?: string; oai?: Record<string, string>; v1?: Record<string, string> }
/** answers searches by their kind (an AND of title words, an OR of them, an abstract phrase), versioned ids and history */
function fakeArxiv(route: Route): Http & { asked: string[] } {
  const asked: string[] = [];
  const http = {
    sent: 0,
    asked,
    async get(url: string): Promise<string> {
      http.sent++;
      const u = new URL(url);
      if (u.hostname === 'oaipmh.arxiv.org') {
        const id = u.searchParams.get('identifier')!.replace('oai:arXiv.org:', '');
        asked.push(`oai ${id}`);
        return route.oai?.[id] ?? OAI_MISSING;
      }
      const idList = u.searchParams.get('id_list');
      if (idList) {
        asked.push(`id ${idList}`);
        return route.v1?.[idList] ?? EMPTY_ATOM;
      }
      const q = u.searchParams.get('search_query')!;
      const kind = q.startsWith('abs:"') ? 'phrase' : q.includes(' OR ') ? 'or' : 'and';
      asked.push(`${kind} ${u.searchParams.get('max_results')}`);
      return route[kind] ?? EMPTY_ATOM;
    },
  };
  return http;
}

const DOC = { source_id: 'doc-1', title: 'Mutual Consistency for Hard Regions', human: ABSTRACT };

test('lookup: a single-version paper takes one request and no history', async () => {
  const http = fakeArxiv({ and: feed([{ id: '2101.00001', v: 1, title: DOC.title, summary: ABSTRACT, published: '2021-01-05' }]) });
  const row = await lookup(DOC, http);
  assert.deepEqual(http.asked, ['and 10']);
  assert.deepEqual(row, {
    source_id: 'doc-1', arxiv_id: '2101.00001', title: DOC.title, match: 'title', abstract_overlap: 1,
    versions: [{ v: 1, date: '2021-01-05' }], history: 'full', excluded: false, reason: 'every version predates 2022-11-30',
  });
});

test('lookup: a paper whose newest version predates the window needs no history', async () => {
  const http = fakeArxiv({ and: feed([{ id: '1705.08790', v: 3, title: DOC.title, summary: ABSTRACT, published: '2017-05-24', updated: '2018-04-09' }]) });
  const row = await lookup(DOC, http);
  assert.deepEqual(http.asked, ['and 10']);
  assert.deepEqual(row.versions, [{ v: 1, date: '2017-05-24' }, { v: 3, date: '2018-04-09' }]);
  assert.equal(row.history, 'first-and-last');
  assert.equal(row.excluded, false);
});

test('lookup: a newer version fetches the whole history, and a version inside the window excludes', async () => {
  const hit = feed([{ id: '1202.0001', v: 4, title: DOC.title, summary: ABSTRACT, published: '2012-02-16', updated: '2025-03-25' }]);
  // the newest version is after RAID was built, but the one before it is inside the window
  let http = fakeArxiv({ and: hit, oai: { '1202.0001': oai('1202.0001', ['2012-02-16', '2012-06-05', '2023-02-01', '2025-03-25']) } });
  let row = await lookup(DOC, http);
  assert.deepEqual(http.asked, ['and 10', 'oai 1202.0001']);
  assert.equal(row.history, 'full');
  assert.equal(row.versions.length, 4);
  assert.deepEqual([row.excluded, row.reason], [true, 'v3 2023-02-01 posted between 2022-11-30 and 2024-06-04']);
  // the same paper without that version is kept: its only late version came after RAID
  http = fakeArxiv({ and: hit, oai: { '1202.0001': oai('1202.0001', ['2012-02-16', '2012-06-05', '2021-01-01', '2025-03-25']) } });
  row = await lookup(DOC, http);
  assert.equal(row.excluded, false);
  // with fullHistory even an old multi-version paper is fetched
  http = fakeArxiv({
    and: feed([{ id: '1705.08790', v: 2, title: DOC.title, summary: ABSTRACT, published: '2017-05-24', updated: '2018-04-09' }]),
    oai: { '1705.08790': oai('1705.08790', ['2017-05-24', '2018-04-09']) },
  });
  row = await lookup(DOC, http, { fullHistory: true });
  assert.deepEqual([http.asked, row.history], [['and 10', 'oai 1705.08790'], 'full']);
});

test('lookup: a renamed paper is found by the OR search and confirmed by its abstract', async () => {
  const http = fakeArxiv({
    or: feed([
      { id: '2109.00002', v: 1, title: 'Mutual Consistency for Hard Regions of Graphs', summary: OTHER, published: '2021-09-01' },
      { id: '2109.09960', v: 1, title: 'Mutual Consistency Learning for Hard Regions in Medicine', summary: REVISED, published: '2021-09-21' },
    ]),
  });
  const row = await lookup(DOC, http);
  assert.deepEqual(http.asked, ['and 10', 'or 25']);
  assert.equal(row.arxiv_id, '2109.09960');
  assert.equal(row.arxiv_title, 'Mutual Consistency Learning for Hard Regions in Medicine');
  assert.equal(row.match, 'title+abstract');
  assert.ok(row.abstract_overlap! > 0.4);
  assert.deepEqual(Object.keys(row).slice(0, 5), ['source_id', 'arxiv_id', 'title', 'arxiv_title', 'match'], 'the file reads in this order');
});

test('lookup: the phrase search finds a paper with a wholly new title', async () => {
  const http = fakeArxiv({ phrase: feed([{ id: '2001.00003', v: 1, title: 'Radiology without labels', summary: ABSTRACT, published: '2020-01-03' }]) });
  const row = await lookup(DOC, http);
  assert.deepEqual(http.asked, ['and 10', 'or 25', 'phrase 10']);
  assert.deepEqual([row.arxiv_id, row.match], ['2001.00003', 'abstract']);
});

test('lookup: a paper renamed and rewritten later is recognised by its first version', async () => {
  // close in title, nothing in common in the abstract: not accepted, but worth a look
  const now = { id: '2103.11594', v: 3, title: 'Mutual Consistency for Hard Labels in Radiology', summary: OTHER, published: '2021-03-22', updated: '2021-12-20' };
  assert.equal(pickMatch(DOC, parseAtom(feed([now]))), null);
  const first = feed([{ ...now, v: 1, title: DOC.title, summary: ABSTRACT, updated: '2021-03-22' }]);
  let http = fakeArxiv({ or: feed([now]), v1: { '2103.11594v1': first } });
  let row = await lookup(DOC, http);
  assert.deepEqual(http.asked, ['and 10', 'or 25', 'phrase 10', 'id 2103.11594v1']);
  assert.deepEqual([row.arxiv_id, row.match, row.abstract_overlap, row.arxiv_title], ['2103.11594', 'first-version', 1, now.title]);
  // the history is the paper's, not the first version's
  assert.deepEqual(row.versions, [{ v: 1, date: '2021-03-22' }, { v: 3, date: '2021-12-20' }]);
  // with no abstract to compare, the first version's title alone is enough
  http = fakeArxiv({ or: feed([now]), v1: { '2103.11594v1': first } });
  row = await lookup({ source_id: 'doc-3', title: DOC.title }, http);
  assert.deepEqual([row.arxiv_id, row.match, row.abstract_overlap], ['2103.11594', 'first-version', null]);
});

test('lookup: near misses whose first versions differ too stay unmatched, after two checks at most', async () => {
  const near = (id: string, title: string) => ({ id, v: 2, title, summary: OTHER, published: '2020-01-01', updated: '2020-02-01' });
  const http = fakeArxiv({
    or: feed([near('2001.1', 'Mutual Consistency for Hard Regions of Graphs'), near('2001.2', 'Mutual Consistency for Hard Regions of Trees'),
      near('2001.3', 'Mutual Consistency for Hard Regions of Rings'), { ...near('2001.4', 'Mutual Consistency for Hard Regions of Fields'), v: 1 }]),
    v1: { '2001.1v1': feed([{ ...near('2001.1', 'Graph colouring'), v: 1 }]) },
  });
  const row = await lookup(DOC, http);
  assert.equal(row.arxiv_id, null);
  assert.equal(http.asked.filter((a) => a.startsWith('id ')).length, 2, 'only two first versions are fetched, and never for a single-version paper');
});

test('lookup: an old-style id is never asked for its first version, which arXiv answers with a server error', async () => {
  const near = (id: string, title: string) => ({ id, v: 2, title, summary: OTHER, published: '2002-11-01', updated: '2003-02-01' });
  const http = fakeArxiv({ or: feed([near('quant-ph/0211021', 'Mutual Consistency for Hard Regions of Graphs'), near('2001.2', 'Mutual Consistency for Hard Regions of Trees')]) });
  const row = await lookup(DOC, http);
  assert.equal(row.arxiv_id, null);
  assert.deepEqual(http.asked.filter((a) => a.startsWith('id ')), ['id 2001.2v1']);
  assert.deepEqual(nearMisses(DOC, [{ id: 'math/0211159', version: 3, title: DOC.title.replace('Mutual', 'Joint'), summary: '', published: '2002-11-11', updated: '2003-01-01' }]), []);
});

test('lookup: nothing found is kept and counted, not excluded; without text there is no phrase search', async () => {
  let http = fakeArxiv({});
  let row = await lookup(DOC, http);
  assert.equal(http.asked.length, 3);
  assert.deepEqual(row, { source_id: 'doc-1', arxiv_id: null, title: DOC.title, versions: [], excluded: false, reason: 'no arXiv record found by title or abstract' });
  http = fakeArxiv({ or: feed([{ id: '2109.09960', v: 1, title: 'Mutual Consistency Learning for Hard Regions in Medicine', summary: ABSTRACT, published: '2021-09-21' }]) });
  row = await lookup({ source_id: 'doc-2', title: DOC.title }, http);
  assert.deepEqual(http.asked, ['and 10', 'or 25']);
  assert.equal(row.arxiv_id, null, 'a renamed paper cannot be confirmed without the abstract');
});

test('lookup: a record first posted after RAID was built is not the document', async () => {
  const late = { id: '2503.00001', v: 1, title: DOC.title, summary: ABSTRACT, published: '2025-03-01' };
  let http = fakeArxiv({ and: feed([late]) });
  let row = await lookup({ ...DOC, title: `${DOC.title}\n  ` }, http);
  assert.equal(row.arxiv_id, null);
  assert.equal(row.title, DOC.title, 'line wraps are joined in the file');
  assert.equal(row.reason, 'the only matching record, 2503.00001, was first posted 2025-03-01, after RAID was built');
  // with the real one also on the page, the real one is taken
  http = fakeArxiv({ and: feed([late, { id: '2101.00001', v: 1, title: DOC.title, summary: ABSTRACT, published: '2021-01-05' }]) });
  row = await lookup(DOC, http);
  assert.equal(row.arxiv_id, '2101.00001');
});

test('lookup: a history arXiv does not have is kept undated, not guessed, and does not stop the run', async () => {
  const http = fakeArxiv({ and: feed([{ id: '1202.0001', v: 2, title: DOC.title, summary: ABSTRACT, published: '2012-02-16', updated: '2023-07-25' }]) });
  const row = await lookup(DOC, http);
  assert.equal(row.arxiv_id, '1202.0001');
  assert.deepEqual(row.versions, []);
  assert.equal(row.excluded, false, 'a newest version inside the window is not enough without the history');
  assert.match(row.reason, /OAI-PMH has no record for 1202\.0001.*kept undated/);
  assert.equal(isDated(row), false);
  const skipped = skippedRow({ source_id: 'doc-9', title: 'A  title\n wrapped' });
  assert.deepEqual({ ...skipped, reason: '' }, { source_id: 'doc-9', arxiv_id: null, title: 'A title wrapped', versions: [], excluded: false, reason: '' });
  // both count as not dated, and are told apart in the counts
  assert.deepEqual(countRows([row, skipped, { ...row, source_id: 'doc-3', versions: [{ v: 1, date: '2012-02-16' }], excluded: false, reason: '' }], new Set(['doc-9'])),
    { documents: 3, matched: 1, unmatched: 2, excluded: 0, no_history: 1, skipped: 1 });
});

test('politeClient: giving up on a host that keeps refusing is transient; a 404 is not', async () => {
  const clock = fakeClock();
  const down = scriptedFetch(clock, [{ status: 503 }, { status: 503 }]);
  const a = politeClient({ cacheDir: null, retries: 1, fetchImpl: down.impl, sleep: clock.sleep, now: clock.now });
  await assert.rejects(a.get('https://export.arxiv.org/api/query?x'), (e: Error) => e instanceof TransientError);
  const gone = scriptedFetch(clock, [{ status: 404 }]);
  const b = politeClient({ cacheDir: null, fetchImpl: gone.impl, sleep: clock.sleep, now: clock.now });
  await assert.rejects(b.get('https://export.arxiv.org/api/query?y'), (e: Error) => !(e instanceof TransientError) && /404/.test(e.message));
});

test('searchesFor: precise first, wide last; a title with no safe word goes straight to the phrase', () => {
  const s = searchesFor(DOC);
  assert.deepEqual(s.map((x) => x.max), [10, 25, 10]);
  assert.equal(s[0]!.query, 'ti:consistency AND ti:regions AND ti:mutual AND ti:hard');
  assert.equal(s[1]!.query, 'ti:consistency OR ti:regions OR ti:mutual OR ti:hard');
  assert.match(s[2]!.query, /^abs:"[a-z ]+"$/);
  assert.deepEqual(searchesFor({ source_id: 'x', title: '$\\mathbb{R}^n$', human: ABSTRACT }).map((x) => x.max), [10]);
  assert.deepEqual(searchesFor({ source_id: 'x', title: 'Graphs' }).map((x) => x.query), ['ti:graphs']);
});

// --- the polite client, on a fake clock ---

function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}

type Answer = { status: number; body?: string; headers?: Record<string, string> } | Error;

/** a fetch that answers from a script, takes `latency` ms each time, and records when it was called */
function scriptedFetch(clock: ReturnType<typeof fakeClock>, answers: Answer[], latency = 400) {
  const calls: { at: number; end: number; url: string; ua: string }[] = [];
  let open = 0, maxOpen = 0;
  const impl = async (url: string, init: RequestInit): Promise<Response> => {
    const at = clock.now();
    open++;
    maxOpen = Math.max(maxOpen, open);
    await new Promise((r) => setImmediate(r));
    clock.advance(latency);
    open--;
    calls.push({ at, end: clock.now(), url, ua: (init.headers as Record<string, string>)['user-agent']! });
    const a = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (a instanceof Error) throw a;
    return new Response(a.body ?? '', { status: a.status, headers: a.headers ?? {} });
  };
  return { impl, calls, maxOpen: () => maxOpen };
}

test('politeClient: three seconds from each answer to the next request, and never less', async () => {
  const clock = fakeClock();
  const f = scriptedFetch(clock, [{ status: 200, body: EMPTY_ATOM }]);
  const http = politeClient({ cacheDir: null, gapMs: 1000, fetchImpl: f.impl, sleep: clock.sleep, now: clock.now });
  for (const u of ['https://export.arxiv.org/api/query?a', 'https://export.arxiv.org/api/query?b', 'https://oaipmh.arxiv.org/oai?c']) await http.get(u);
  assert.equal(http.sent, 3);
  for (let i = 1; i < f.calls.length; i++) assert.ok(f.calls[i]!.at - f.calls[i - 1]!.end >= MIN_GAP_MS, `request ${i} came too soon`);
  assert.match(f.calls[0]!.ua, /is-it-really-an-ai-tell.*github\.com\/barbarkaragul-oss\/is-it-really-an-ai-tell/);
});

test('politeClient: callers in parallel still get one request at a time', async () => {
  const clock = fakeClock();
  const f = scriptedFetch(clock, [{ status: 200, body: EMPTY_ATOM }]);
  const http = politeClient({ cacheDir: null, fetchImpl: f.impl, sleep: clock.sleep, now: clock.now });
  await Promise.all(['a', 'b', 'c', 'd'].map((x) => http.get(`https://export.arxiv.org/api/query?${x}`)));
  assert.equal(f.maxOpen(), 1);
  assert.equal(f.calls.length, 4);
});

test('politeClient: 503 waits for Retry-After, a network error backs off, a 404 fails at once', async () => {
  let clock = fakeClock();
  let f = scriptedFetch(clock, [{ status: 503, headers: { 'retry-after': '20' } }, new TypeError('socket hang up'), { status: 200, body: EMPTY_ATOM }]);
  let http = politeClient({ cacheDir: null, fetchImpl: f.impl, sleep: clock.sleep, now: clock.now });
  assert.equal(await http.get('https://export.arxiv.org/api/query?x'), EMPTY_ATOM);
  assert.equal(http.sent, 3);
  assert.ok(f.calls[1]!.at - f.calls[0]!.end >= 20_000, 'Retry-After is honoured');
  assert.ok(f.calls[2]!.at - f.calls[1]!.end >= 10_000, 'the second failure waits longer');

  clock = fakeClock();
  f = scriptedFetch(clock, [{ status: 404 }]);
  http = politeClient({ cacheDir: null, fetchImpl: f.impl, sleep: clock.sleep, now: clock.now });
  await assert.rejects(http.get('https://export.arxiv.org/api/query?y'), /404/);
  assert.equal(http.sent, 1);

  clock = fakeClock();
  f = scriptedFetch(clock, [{ status: 429 }]);
  http = politeClient({ cacheDir: null, retries: 2, fetchImpl: f.impl, sleep: clock.sleep, now: clock.now });
  await assert.rejects(http.get('https://export.arxiv.org/api/query?z'), /gave up after 3 tries/);
  assert.equal(http.sent, 3);

  // a failed request still spaces the next one
  clock = fakeClock();
  f = scriptedFetch(clock, [{ status: 404 }, { status: 200, body: EMPTY_ATOM }]);
  http = politeClient({ cacheDir: null, fetchImpl: f.impl, sleep: clock.sleep, now: clock.now });
  await assert.rejects(http.get('https://export.arxiv.org/api/query?p'));
  await http.get('https://export.arxiv.org/api/query?q');
  assert.ok(f.calls[1]!.at - f.calls[0]!.end >= MIN_GAP_MS);
});

test('politeClient: good answers are cached and reused; errors and non-feeds are not; empty searches can be refreshed', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arxiv-cache-'));
  try {
    const clock = fakeClock();
    const f = scriptedFetch(clock, [
      { status: 200, body: ATOM }, // a
      { status: 200, body: ERROR_ATOM }, // b, twice
      { status: 200, body: ERROR_ATOM },
      { status: 200, body: '<html>maintenance</html>' }, // c
      { status: 200, body: EMPTY_ATOM }, // d
      { status: 200, body: OAI_MISSING }, // e
      { status: 200, body: ATOM }, // d again, refreshed
    ]);
    const opts = { cacheDir: dir, fetchImpl: f.impl, sleep: clock.sleep, now: clock.now };
    const http = politeClient(opts);
    const api = (x: string): string => `https://export.arxiv.org/api/query?search_query=${x}`;
    assert.equal(await http.get(api('a')), ATOM);
    assert.equal(await http.get(api('a')), ATOM);
    assert.equal(http.sent, 1, 'the second answer came from the cache');
    await http.get(api('b'));
    await http.get(api('b'));
    assert.equal(http.sent, 3, 'an API error is asked again');
    assert.equal(await http.get(api('c')), '<html>maintenance</html>');
    await http.get(api('d'));
    await http.get('https://oaipmh.arxiv.org/oai?verb=GetRecord&identifier=oai%3AarXiv.org%3A1');
    const files = readdirSync(dir).sort();
    assert.equal(files.length, 3, `only a, d and e are kept: ${files.join(' ')}`);
    assert.equal(files.filter((x) => x.startsWith('oai-')).length, 1);

    // a new run reads the cache and sends nothing, unless it asks for empty searches again
    const again = politeClient(opts);
    assert.equal(await again.get(api('d')), EMPTY_ATOM);
    assert.equal(again.sent, 0);
    const refresh = politeClient({ ...opts, refreshEmpty: true });
    assert.equal(await refresh.get(api('a')), ATOM, 'a search with results is not refreshed');
    assert.equal(await refresh.get(api('d')), ATOM);
    assert.equal(refresh.sent, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('serialize and readDates: one document per line; the excluded and the unmatched come back as sets', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arxiv-dates-'));
  try {
    const rows: DateRow[] = [
      { source_id: 'a', arxiv_id: '1202.0001', title: 'A', match: 'title', abstract_overlap: 1, versions: [{ v: 1, date: '2012-02-16' }, { v: 4, date: '2023-07-25' }], history: 'full', excluded: true, reason: 'v4 2023-07-25 posted between 2022-11-30 and 2024-06-04' },
      { source_id: 'b', arxiv_id: null, title: 'B "quoted"', versions: [], excluded: false, reason: 'no arXiv record found by title or abstract' },
      { source_id: 'c', arxiv_id: '1705.08790', title: 'C', match: 'title', abstract_overlap: null, versions: [{ v: 1, date: '2017-05-24' }], history: 'full', excluded: false, reason: 'every version predates 2022-11-30' },
    ];
    const text = serialize({ complete: true, window: { from: '2022-11-30', to: '2024-06-04' }, counts: { documents: 3, matched: 2, unmatched: 1, excluded: 1 } }, rows);
    assert.equal(text.split('\n').filter((l) => l.startsWith('  {"source_id"')).length, 3);
    const file = path.join(dir, 'dates.json');
    writeFileSync(file, text);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(parsed.documents, rows);
    assert.equal(parsed.complete, true);
    const read = readDates(file)!;
    assert.deepEqual([...read.excluded], ['a']);
    assert.deepEqual([...read.unmatched], ['b']);
    assert.equal(read.file.counts.documents, 3);
    assert.equal(readDates(path.join(dir, 'missing.json')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
