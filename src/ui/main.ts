/**
 * The page. Everything it counts in a pasted text is counted by src/markers.ts, the same code that
 * produced the table, and nothing typed here leaves the browser.
 *
 * It opens with the grid across kinds of writing (docs/data/summary.json) and loads one kind's
 * table, documents and evidence (docs/data/genres/<genre>.json) when that kind is picked. No writer
 * or kind of writing is named here: the columns, their names and the wording of the verdicts come
 * from the data, which comes from scripts/genres.ts.
 */
import { MARKERS, byId, readable, words as countWords, type Marker } from '../markers.js';

export interface WriterInfo { id: string; short: string; long: string; quotable: boolean }
export interface GenreInfo {
  id: string; label: string; inText: string; noun: { one: string; many: string }; prompt: string; reference: string; decider: string; deciderShort: string;
  titles: 'show' | 'hide'; humanQuotable: boolean; documents: string;
  source: { human: string; humanUrl: string; people: string; dates: string; datesUrl: string; licence: string; licenceUrl: string };
  /** markers this kind of writing cannot show in anyone's text, with the reason */
  notRecorded?: Record<string, string>;
}
/** where the dating of a kind of writing stands (scripts/build.ts, datingOf) */
export type Dating =
  | { status: 'none' }
  | { status: 'unchecked' }
  | { status: 'not applied' }
  | { status: 'partial' | 'applied'; documents: number; excluded: number; unmatched: number; notLookedUp: number; firstPosted: [string, string] | null };
interface ArmInfo { id: string; label: string; kind: string; n: number; matched: number; pairing?: string; medianWords: number; publishable: boolean; we: number }
interface RateCell { v: number; lo: number; hi: number; occ: number; words: number }
interface ShareCell { v: number; lo: number; hi: number; k: number; n: number; ref: number; rlo: number; rhi: number }
interface Row {
  marker: string; label: string; family: string; belief: boolean; countable: boolean; verdict: string; placeboTie: boolean;
  rate: Record<string, RateCell>; share: Record<string, ShareCell>;
}
interface Example { id: string; sentence?: string; link?: string }
interface Cell { occurrences: number; forms: [string, number][]; before: [string, number][]; examples: Example[] }
interface Doc { source_id: string; title: string; texts: Record<string, string>; person_not_reproduced?: boolean }
interface ArmCleaning { arm: string; texts: number; dated: number; language?: number; truncated: number | null; meta: number | null; remembered: number | null; unchecked: number | null; kept: number; reported: { truncated: number; meta: number } | null }
interface Page {
  generated_at: string; reference: string; machine: string;
  genre: GenreInfo; writers: WriterInfo[]; context: WriterInfo[];
  arms: ArmInfo[]; rows: Row[]; evidence: Record<string, Record<string, Cell>>; documents: Doc[];
  cleaning: { dates: Dating | null; language?: { documents: number; excluded: number } | null; arms: ArmCleaning[] } | null;
}
export interface KCount { ai: number; person: number; of: number; tooFew?: number }
/** what one model's comparison rested on (scripts/measure-all.ts, evidenceOf) */
export type Evidence = { occurrences: number } | { pairs: number; minority: number };
export interface GridCell {
  verdict: string; q: number | null; placeboTie: boolean; unit: string; person: number | null; decider: number | null; n: number;
  k: KCount | null; models: Record<string, { verdict: string; q: number | null; evidence?: Evidence; tooFew?: boolean }> | null;
}
export interface SummaryGenre extends GenreInfo { file: string; texts: number; placebo_disagreements: number; dating?: Dating }
export interface Summary {
  generated_at: string; measured: boolean; models: { id: string; short: string; snapshot: string }[]; decoding: string; k_rule: string | null; not_covered: string;
  genres: SummaryGenre[];
  rows: { marker: string; label: string; family: string; belief: boolean; countable: boolean; genres: Record<string, GridCell> }[];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);

// ---- wording, from the data

type Words = [cls: string, text: string, byRate: string, byShare: string];

/**
 * A word is decided on its rates over every text, a property of the whole text on its shares, so
 * each verdict is explained in the terms of the test that produced it, and in the kind of writing.
 */
export function verdictWords(verdict: string, g: Pick<GenreInfo, 'deciderShort' | 'noun'>): Words {
  const d = g.deciderShort, docs = g.noun.many;
  const table: Record<string, Words> = {
    'machine marker': ['machine', `${d} marker`,
      `${d} uses it more often than the person who wrote the same ${docs}, comparing texts of the same length, by more than testing ${MARKERS.length} markers at once would produce by chance.`,
      `More of ${d}’s texts have it than the person’s on the same ${docs}, and the two 95% intervals do not overlap.`],
    'register marker': ['register', 'careful writing',
      `The person and ${d} cannot be told apart on it, and both use it more than casual writers do. It marks how formally something is written, not who wrote it.`,
      `The person and ${d} cannot be told apart on it, and more of both their texts have it than casual writing does. It marks how formally something is written, not who wrote it.`],
    'points the other way': ['other', 'more human',
      `The person uses it more often than ${d} does on the same ${docs}, comparing texts of the same length, by more than testing ${MARKERS.length} markers at once would produce by chance.`,
      `More of the person’s texts have it than ${d}’s on the same ${docs}, and the two 95% intervals do not overlap.`],
    'no signal': ['none', 'no signal', `No difference between the person and ${d} that the data can support.`, `No difference between the person and ${d} that the data can support.`],
    'not recorded': ['none', 'not recorded', '', ''],
  };
  return table[verdict] ?? ['none', verdict, '', ''];
}

/** why a verdict is what it is: the test's own words, or the reason a marker is not recorded here */
export function whyOf(verdict: string, g: Pick<GenreInfo, 'deciderShort' | 'noun' | 'notRecorded'>, marker: string, countable: boolean): string {
  if (verdict === 'not recorded') return g.notRecorded?.[marker] ?? '';
  const [, , byRate, byShare] = verdictWords(verdict, g);
  return countable ? byRate : byShare;
}

/** a glyph for every verdict, so a cell never relies on its colour alone */
export const GLYPH: Record<string, string> = {
  'machine marker': '▲', 'points the other way': '▼', 'register marker': '◆', 'no signal': '–', 'not recorded': '·',
};

/**
 * A model's evidence, in words: "12 uses" for a word; for a property of the whole text, the pairs and
 * how many texts of both sides are on its rarer side ("504 pairs, 1 on the rarer side": everyone but
 * one text has it, so nothing can be told apart).
 */
const evidenceWords = (e: Evidence | undefined): string =>
  !e ? '' : 'occurrences' in e ? `${e.occurrences} use${e.occurrences === 1 ? '' : 's'}` : `${e.pairs} pairs, ${e.minority} on the rarer side`;

/**
 * "k of 4": how many models the marker separates from the person, in each direction, of those that
 * could be compared. A model whose comparison rests on too little is not counted in "of"; when that is
 * every model, the cell says so instead of "0 of 0".
 */
export function kHtml(k: KCount | null, models: GridCell['models'], names: Map<string, string>): string {
  // no count before the new measurement, and none for a marker no model could be measured on
  if (!k || (k.of === 0 && !k.tooFew)) return '';
  const who = models
    ? Object.entries(models).map(([m, v]) => `${names.get(m) ?? m} ${v.tooFew ? 'too few' : GLYPH[v.verdict] ?? v.verdict}${v.evidence ? ` (${evidenceWords(v.evidence)})` : ''}`).join(', ')
    : '';
  const few = k.tooFew ? `, and ${k.tooFew} with too little to compare` : '';
  const title = `Models whose own comparison with the person separates this marker: ${k.ai} toward the model (▲), ${k.person} toward the person (▼), of ${k.of} compared${few}. ${who}`;
  if (k.of === 0) return `<span class="k" title="${esc(title)}">too little to compare</span>`;
  const parts: string[] = [];
  if (k.ai) parts.push(`▲ ${k.ai} of ${k.of} models`);
  if (k.person) parts.push(`▼ ${k.person} of ${k.of} models`);
  if (!parts.length) parts.push(`0 of ${k.of} models`);
  return `<span class="k" title="${esc(title)}">${parts.join(' · ')}</span>`;
}

export function gridCellHtml(cell: GridCell | undefined, g: SummaryGenre, marker: string, names: Map<string, string>): string {
  if (!cell) return `<td class="gcell"><span class="muted">–</span></td>`;
  const [cls, text] = verdictWords(cell.verdict, g);
  const why = whyOf(cell.verdict, g, marker, cell.unit === 'per 1000 words');
  const fmt = (x: number | null): string => (x === null ? '–' : cell.unit === 'per 1000 words' ? x.toFixed(2) : `${x.toFixed(1)}%`);
  const numbers = `Person ${fmt(cell.person)}, ${g.deciderShort} ${fmt(cell.decider)} (${cell.unit})${cell.q !== null ? `, q ${cell.q < 0.001 ? '< 0.001' : cell.q.toFixed(3)}` : ''}.`;
  const placebo = cell.placeboTie ? '' : '<span class="flag">placebo disagrees</span>';
  return `<td class="gcell" data-genre="${esc(g.id)}" data-marker="${esc(marker)}" tabindex="0" title="${esc(`${why} ${numbers}`)}">`
    + `<span class="pill ${cls}">${GLYPH[cell.verdict] ?? ''} ${esc(text)}</span>${kHtml(cell.k, cell.models, names)}${placebo}</td>`;
}

/**
 * Where the dating of a kind of writing stands, in the page's words; empty for a kind without a
 * dating rule. A partial lookup is said to be partial, with how much of it is still to do.
 */
export function datingWords(d: Dating | null | undefined, noun: { many: string }): string {
  if (!d || d.status === 'none') return '';
  if (d.status === 'unchecked') return 'The numbers shown were measured before this rule existed; the next weekly measurement applies it.';
  if (d.status === 'not applied') return `This rule is not applied yet: the ${noun.many} have not been dated.`;
  const unmatched = d.unmatched ? ` ${d.unmatched} could not be matched to a paper and are kept.` : '';
  const years = d.firstPosted ? ` The dated ones were first posted between ${d.firstPosted[0].slice(0, 4)} and ${d.firstPosted[1].slice(0, 4)}.` : '';
  if (d.status === 'partial') {
    return `The dating is partial: ${d.documents - d.notLookedUp} of ${d.documents} ${noun.many} have been looked up and ${d.excluded} left out; the other ${d.notLookedUp} are kept until they are dated.${unmatched}${years}`;
  }
  return `${d.excluded} of ${d.documents} ${noun.many} are left out by it.${unmatched}${years}`;
}

/** whether the dates behind a kind of writing exist to link to: a lookup not yet committed has no page */
export const datesLinked = (d: Dating | null | undefined): boolean => !d || d.status === 'none' || d.status === 'applied' || d.status === 'partial';

/** who the people are, for the grid's column head, with the years the dating found */
export function peopleWords(g: Pick<SummaryGenre, 'source' | 'dating'>): string {
  const d = g.dating;
  if (d && (d.status === 'applied' || d.status === 'partial') && d.firstPosted) {
    return `${g.source.people}, first posted ${d.firstPosted[0].slice(0, 4)}–${d.firstPosted[1].slice(0, 4)}${d.status === 'partial' ? ' (of those dated so far)' : ''}`;
  }
  return g.source.people;
}

/** the kind of writing named in the address, as "#genre=posts" */
export function genreFromHash(hash: string, ids: string[]): string | null {
  const m = /^#genre=([a-z0-9-]+)(?:&marker=([a-z0-9_]+))?$/.exec(hash);
  return m && ids.includes(m[1]!) ? m[1]! : null;
}

// ---- state

let summary: Summary;
let current: Page | null = null;
const pages = new Map<string, Promise<Page>>();
const shortOf = (id: string): string => current?.writers.concat(current.context).find((w) => w.id === id)?.short ?? id;
const longOf = (id: string): string => current?.writers.concat(current.context).find((w) => w.id === id)?.long ?? '';

// ---- theme: the stored choice wins, otherwise the system's
function setupTheme(): void {
  $('theme').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('theme', root.dataset.theme); } catch { /* private window: the choice lasts for this visit */ }
  });
}

// ---- number formatting
const fmtRate = (c: RateCell | undefined): string => (!c ? '–' : c.occ === 0 ? '0' : c.v < 0.01 ? '<0.01' : c.v.toFixed(2));
const fmtShare = (c: ShareCell | undefined): string => (!c ? '–' : `${c.v.toFixed(1)}%`);

/** a tint only where the two intervals do not overlap; stronger for a bigger ratio */
function tint(value: number, lo: number, hi: number, pv: number, plo: number, phi: number, eps: number): string {
  const dir = lo > phi ? 'up' : hi < plo ? 'down' : '';
  if (!dir) return '';
  const strength = Math.min(1, Math.abs(Math.log2((value + eps) / (pv + eps))) / 4);
  return `background: rgba(var(--${dir}), ${(0.12 + 0.4 * strength).toFixed(2)})`;
}

// how an arm's shares were paired with the person's, for the tooltip
const paired = (pairing: string | undefined, g: GenreInfo): string => ({
  document: `each paired with the person’s text for the same ${g.noun.one}, both in the same length band`,
  length: 'length-matched with the person',
  self: `the person’s own ${g.noun.many}`,
} as Record<string, string>)[pairing ?? 'length'] ?? 'length-matched with the person';

function rateCellHtml(page: Page, row: Row, arm: string, tinted: boolean): string {
  const c = row.rate[arm];
  const p = row.rate[page.reference];
  const title = c ? `${c.occ} in ${c.words.toLocaleString('en')} words · 95% interval ${c.lo.toFixed(2)}–${c.hi.toFixed(2)}` : '';
  const style = tinted && c && p && arm !== page.reference ? tint(c.v, c.lo, c.hi, p.v, p.lo, p.hi, 0.02) : '';
  return `<td class="num${c && c.occ === 0 ? ' dim' : ''}" title="${esc(title)}" style="${style}">${fmtRate(c)}</td>`;
}

function shareCellHtml(page: Page, row: Row, arm: string, tinted: boolean, pairing: string | undefined): string {
  const c = row.share[arm];
  // a marker that cannot judge a short text counts only the texts it can
  const judged = pairing && byId.get(row.marker)?.eligible ? ' long enough to judge' : '';
  const title = c ? `${c.k} of ${c.n} texts${judged}, ${paired(pairing, page.genre)} · 95% interval ${c.lo.toFixed(1)}–${c.hi.toFixed(1)}%` : '';
  const style = tinted && c && arm !== page.reference ? tint(c.v, c.lo, c.hi, c.ref, c.rlo, c.rhi, 1) : '';
  return `<td class="num" title="${esc(title)}" style="${style}">${fmtShare(c)}</td>`;
}

// ---- the grid across kinds of writing

function renderGrid(): void {
  const names = new Map(summary.models.map((m) => [m.id, m.short]));
  const head = `<thead><tr><th>Marker</th>${summary.genres.map((g) => `<th class="gcol"><button type="button" class="glink" data-genre="${esc(g.id)}">${esc(g.label)}</button>`
    + `<span class="sub">people: ${esc(peopleWords(g))}</span><span class="sub">${g.texts.toLocaleString('en')} ${esc(g.noun.many)}, ${esc(g.deciderShort)} vs the person</span></th>`).join('')}</tr></thead>`;
  const body = summary.rows.map((r) => `<tr><td>${esc(r.label)}${r.belief ? '<span class="belief">people judge by it</span>' : ''}</td>`
    + summary.genres.map((g) => gridCellHtml(r.genres[g.id], g, r.marker, names)).join('') + '</tr>').join('');
  $('grid').innerHTML = `${head}<tbody>${body}</tbody>`;
  const modelNames = summary.models.map((m) => m.short).join(', ');
  const d = esc(summary.genres[0]?.deciderShort ?? 'the model');
  $('grid-caption').innerHTML = summary.measured
    ? `Each cell is one kind of writing. The label is ${d}’s verdict against the people who wrote the same documents, as in the table below. Under it, how many of the ${summary.models.length} models (${esc(modelNames)}; ${esc(summary.decoding)}) the marker separates from the person there, each decided by the same rules: ▲ toward the model, ▼ toward the person. A model is counted only where there is something to compare: a word that it and the person hardly use, or a property every text has, leaves too little. Click a cell for that kind’s full table.`
    : `Each cell is one kind of writing, with ${d}’s verdict against the people who wrote the same documents. The count across all ${summary.models.length} models appears after the next weekly measurement. Click a cell for the full table.`;
  $('kinds').innerHTML = summary.genres.map((g) => ` <b>${esc(g.label)}:</b> the people’s texts are ${esc(g.source.human)}. ${esc(g.source.dates)} ${esc(datingWords(g.dating, g.noun))} `
    + `(${datesLinked(g.dating) ? `<a href="${esc(g.source.datesUrl)}" rel="noopener">source</a>; ` : ''}${g.humanQuotable ? '' : 'not quoted: '}<a href="${esc(g.source.licenceUrl)}" rel="noopener">${esc(g.source.licence)}</a>.)`).join('');
  $('not-covered').textContent = `Not covered: ${summary.not_covered}. Paired sets of a person’s text and models writing the same thing do exist for some of these, but none that can be used here under its terms, so they are left out rather than guessed at.`;
}

// ---- one kind of writing: the table

function renderTable(page: Page): void {
  const present = new Set(page.arms.map((a) => a.id));
  const writers = page.writers.map((w) => w.id).filter((a) => present.has(a));
  const context = page.context.map((w) => w.id).filter((a) => present.has(a));
  const cols = writers.length + context.length + 2;
  const tip = (a: string): string => esc(longOf(a));
  const pairing = new Map(page.arms.map((a) => [a.id, a.pairing]));
  const head = `<thead><tr><th>Marker</th>${writers.map((a) => `<th title="${tip(a)}">${esc(shortOf(a))}</th>`).join('')}${context.map((a, i) => `<th class="ctx${i === 0 ? ' sep' : ''}" title="${tip(a)}">${esc(shortOf(a))}</th>`).join('')}<th>Verdict</th></tr></thead>`;
  const placeboTip = `The person’s ${page.genre.noun.many}, split at random in two, differ on this row by the same test, so the method can produce a difference here from nothing`;
  const line = (row: Row): string => {
    const [cls, text] = verdictWords(row.verdict, page.genre);
    const cell = (a: string, tinted: boolean): string => (row.countable ? rateCellHtml(page, row, a, tinted) : shareCellHtml(page, row, a, tinted, pairing.get(a)));
    const placebo = row.placeboTie === false ? `<span class="flag" title="${esc(placeboTip)}">placebo disagrees</span>` : '';
    return `<tr class="row" data-marker="${row.marker}" tabindex="0" aria-expanded="false">`
      + `<td>${esc(row.label)}${row.belief ? '<span class="belief" title="People are documented to judge by this one">people judge by it</span>' : ''}</td>`
      + writers.map((a) => cell(a, true)).join('')
      + context.map((a, i) => cell(a, false).replace('<td class="num', `<td class="ctx num${i === 0 ? ' sep' : ''}`)).join('')
      + `<td><span class="pill ${cls}" title="${esc(whyOf(row.verdict, page.genre, row.marker, row.countable))}">${GLYPH[row.verdict] ?? ''} ${text}</span>${placebo}</td></tr>`;
  };
  const counted = page.rows.filter((r) => r.countable);
  const whole = page.rows.filter((r) => !r.countable);
  $('markers').innerHTML = head + '<tbody>'
    + `<tr class="group"><th colspan="${cols}">Words and phrases · occurrences per thousand words</th></tr>` + counted.map(line).join('')
    + `<tr class="group"><th colspan="${cols}">Properties of the whole text · share of texts</th></tr>` + whole.map(line).join('')
    + '</tbody>';
}

function toggleRow(tr: HTMLTableRowElement, open?: boolean): void {
  const page = current;
  if (!page) return;
  const next = tr.nextElementSibling;
  const isOpen = !!next && next.classList.contains('detail');
  if (open === undefined ? isOpen : !open) {
    if (isOpen) next.remove();
    tr.classList.remove('open');
    tr.setAttribute('aria-expanded', 'false');
    return;
  }
  if (isOpen) return;
  const row = page.rows.find((r) => r.marker === tr.dataset.marker);
  if (!row) return;
  const cols = tr.children.length;
  const detail = document.createElement('tr');
  detail.className = 'detail';
  detail.innerHTML = `<td colspan="${cols}"><div class="detail-inner"></div></td>`;
  tr.after(detail);
  tr.classList.add('open');
  tr.setAttribute('aria-expanded', 'true');
  renderDetail(detail.querySelector('.detail-inner') as HTMLElement, page, row);
}

function setupTable(): void {
  const table = $('markers');
  table.addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest('tr.row');
    if (tr && !(e.target as HTMLElement).closest('a')) toggleRow(tr as HTMLTableRowElement);
  });
  table.addEventListener('keydown', (e) => {
    const tr = (e.target as HTMLElement).closest('tr.row');
    if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleRow(tr as HTMLTableRowElement); }
  });
}

function renderDetail(box: HTMLElement, page: Page, row: Row): void {
  const m = byId.get(row.marker);
  const why = whyOf(row.verdict, page.genre, row.marker, row.countable);
  const intro = `<p class="muted">${esc(why)}${m ? ` Claimed by: ${esc(m.source)}.` : ''}${m?.pattern ? ` Pattern: <code>${esc(m.pattern.source)}</code>` : ''}</p>`;
  const cells = page.evidence[row.marker] ?? {};
  const order = [...page.writers, ...page.context].map((w) => w.id);
  const arms = order.filter((a) => cells[a]);
  if (!row.countable || !arms.length) {
    const note = row.countable
      ? 'No writer used it at all.'
      : 'This is a property of the whole text, so there is no sentence to show. Hover a number for how many texts it rests on.';
    box.innerHTML = `${intro}<p>${note}</p>`;
    return;
  }
  const writerIds = new Set(page.writers.map((w) => w.id));
  const writersFirst = arms.filter((a) => writerIds.has(a));
  let chosen = [...writersFirst].sort((a, b) => (cells[b]?.occurrences ?? 0) - (cells[a]?.occurrences ?? 0))[0] ?? arms[0]!;
  const draw = (): void => {
    const c = cells[chosen]!;
    const tabs = arms.map((a) => `<button type="button" role="tab" data-arm="${a}" aria-selected="${a === chosen}">${esc(shortOf(a))}<span class="n">${cells[a]!.occurrences}</span></button>`).join('');
    const forms = c.forms.length ? c.forms.map(([f, n]) => `<code>${esc(f)}</code> ${n}`).join(', ') : '<span class="muted">not shown for an arm that cannot be quoted</span>';
    const before = c.before.map(([f, n]) => `<code>${esc(f)}</code> ${n}`).join(', ');
    let examples: string;
    if (chosen === page.reference && !page.genre.humanQuotable) {
      // the person's text here is counted, never shown; the ids are how the corpus is rebuilt
      examples = `<li class="muted">The people’s ${esc(page.genre.noun.many)} are counted, not quoted (${esc(page.genre.source.licence)}). Documents: ${c.examples.map((x) => esc(x.id.replace(/^[a-z0-9]+:[a-z0-9.-]+:/, ''))).join(', ')}.</li>`;
    } else {
      examples = c.examples.map((x) => {
        if (x.sentence) return `<li>${markSentence(x.sentence, m)}</li>`;
        if (x.link) return `<li><a href="${esc(x.link)}" rel="noopener">${esc(x.link.replace(/^https:\/\//, ''))}</a> <span class="muted">(linked, not quoted)</span></li>`;
        return `<li class="muted">${esc(x.id)} (no public link; not quoted)</li>`;
      }).join('');
      if (!c.examples.length) examples = '<li class="muted">No sentence can be shown: each one shares words with a person’s text that may not be quoted.</li>';
    }
    box.innerHTML = `${intro}<div class="tabs" role="tablist">${tabs}</div>`
      + `<div class="facts"><span><b>Matched as</b> ${forms}</span><span><b>Word before</b> ${before}</span></div>`
      + `<ul class="examples">${examples}</ul>`;
  };
  box.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button[data-arm]') as HTMLButtonElement | null;
    if (b?.dataset.arm) { chosen = b.dataset.arm; draw(); }
  });
  draw();
}

// ---- highlighting, with the catalogue's own patterns
const familyClass = (m: Marker): string => (m.family === 'word' ? 'word' : m.family === 'phrase' ? 'phrase' : 'shape');

function markSentence(s: string, m: Marker | undefined): string {
  if (!m?.pattern) return esc(s);
  let html = '', pos = 0;
  for (const x of s.matchAll(m.pattern)) {
    html += esc(s.slice(pos, x.index)) + `<mark class="${familyClass(m)}">${esc(x[0])}</mark>`;
    pos = x.index + x[0].length;
  }
  return html + esc(s.slice(pos));
}

interface Found { counts: Map<string, number>; whole: string[]; unjudged: string[]; html: string; words: number }

function analyse(pasted: string): Found {
  // shown and counted as the measurement reads it, so the highlights and the counts agree with the table
  const text = readable(pasted);
  const spans: { s: number; e: number; m: Marker }[] = [];
  const counts = new Map<string, number>();
  for (const m of MARKERS) {
    if (!m.pattern) continue;
    for (const x of text.matchAll(m.pattern)) {
      spans.push({ s: x.index, e: x.index + x[0].length, m });
      counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
    }
  }
  spans.sort((a, b) => a.s - b.s || b.e - a.e);
  let html = '', pos = 0;
  for (const sp of spans) {
    if (sp.s < pos) continue;
    html += esc(text.slice(pos, sp.s)) + `<mark class="${familyClass(sp.m)}" title="${esc(sp.m.label)}">${esc(text.slice(sp.s, sp.e))}</mark>`;
    pos = sp.e;
  }
  html += esc(text.slice(pos));
  // a marker's own test decides what it reads: the bulleted-list one needs the "**"
  const whole = MARKERS.filter((m) => !m.count && m.test(pasted)).map((m) => m.id);
  // false and "cannot say" are different answers; the table leaves the second kind out, and so does this
  const unjudged = MARKERS.filter((m) => !m.count && m.eligible && !m.eligible(pasted)).map((m) => m.id);
  const words = countWords(text).length;
  return { counts, whole, unjudged, html, words };
}

function foundTable(page: Page, f: Found, writer: string | null): string {
  const rows = new Map(page.rows.map((r) => [r.marker, r]));
  // the person, the decider, and the comparison writing people did (not the comparison model)
  const people = page.context.filter((c) => page.arms.find((a) => a.id === c.id)?.kind === 'human').map((c) => c.id);
  const ctx = [page.reference, page.genre.decider, ...people].filter((a) => page.arms.some((x) => x.id === a));
  const extra = writer && !ctx.includes(writer) ? [writer] : [];
  const cols = [...ctx, ...extra];
  const counted = [...f.counts.entries()].filter(([id]) => rows.has(id));
  const whole = f.whole.filter((id) => rows.has(id));
  const unjudged = f.unjudged.filter((id) => rows.has(id));
  const notJudged = unjudged.length
    ? `<p class="muted">Too short to judge, so left out here just as the table leaves such texts out: ${unjudged.map((id) => esc(rows.get(id)!.label)).join(', ')}.</p>`
    : '';
  if (!counted.length && !whole.length) return '<p class="muted">None of the markers in the table occur in this text.</p>' + notJudged;
  const kind = `${page.genre.inText} column${cols.length === 1 ? '' : 's'}`;
  let out = '';
  if (counted.length) {
    out += `<table><thead><tr><th>In this text</th><th>times</th>${cols.map((a) => `<th>${esc(shortOf(a))}</th>`).join('')}</tr></thead><tbody>`
      + counted.map(([id, n]) => {
        const r = rows.get(id)!;
        return `<tr><td>${esc(r.label)}</td><td>${n}</td>${cols.map((a) => `<td>${fmtRate(r.rate[a])}</td>`).join('')}</tr>`;
      }).join('')
      + `</tbody></table><p class="muted">The columns are occurrences per thousand words in each whole corpus (the ${esc(kind)} and the comparison writing). This text has ${f.words} words.</p>`;
  }
  if (whole.length) {
    out += `<table><thead><tr><th>True of this text</th>${cols.map((a) => `<th>${esc(shortOf(a))}</th>`).join('')}</tr></thead><tbody>`
      + whole.map((id) => {
        const r = rows.get(id)!;
        return `<tr><td>${esc(r.label)}</td>${cols.map((a) => `<td>${fmtShare(r.share[a])}</td>`).join('')}</tr>`;
      }).join('')
      + '</tbody></table><p class="muted">The columns are the share of texts in each corpus that have the same property. On a short text most of these hold by default.</p>';
  }
  return out + notJudged;
}

// ---- one document, every writer

let docIndex = 0;
let docArm = '';

function renderDocument(): void {
  const page = current;
  const section = $('doc-section');
  if (!page || !page.documents.length) { section.hidden = true; return; }
  section.hidden = false;
  const g = page.genre;
  const docs = page.documents;
  docIndex = ((docIndex % docs.length) + docs.length) % docs.length;
  const d = docs[docIndex]!;
  const writers = page.writers.map((w) => w.id).filter((a) => d.texts[a]);
  if (!writers.includes(docArm)) docArm = writers[0] ?? '';
  const hidden = d.person_not_reproduced === true;
  $('doc-heading').textContent = `One ${g.noun.one}, ${writers.length} writers`;
  $('doc-caption').textContent = g.titles === 'show'
    ? `The same prompt, ${g.prompt}, answered ${writers.length} ways. Counted markers are highlighted. Documents are drawn at random from the ones every writer covered, not chosen, and none is about suicide, self-harm, sexual violence, psychosis, overdoses or eating disorders.`
    : `The same prompt, ${g.prompt}, answered by each model. The title and the person’s ${g.noun.one} are not shown (${g.source.licence}); the person’s text is counted in the table all the same. Documents are drawn at random, not chosen, from those where no model repeats the title, five words in a row of the person’s ${g.noun.one} or eight of anyone’s, and none is about suicide, self-harm, sexual violence, psychosis, overdoses or eating disorders.`;
  $('doc-title').textContent = g.titles === 'show' && d.title
    ? `“${d.title}” (${docIndex + 1} of ${docs.length})`
    : `${g.noun.one[0]!.toUpperCase()}${g.noun.one.slice(1)} ${docIndex + 1} of ${docs.length}${hidden ? ' · the person’s version is not reproduced' : ''}`;
  $('doc-tabs').innerHTML = writers.map((a) => `<button type="button" role="tab" data-arm="${a}" aria-selected="${a === docArm}">${esc(shortOf(a))}</button>`).join('');
  const f = analyse(d.texts[docArm] ?? '');
  $('doc-text').innerHTML = f.html;
  $('doc-found').innerHTML = foundTable(page, f, docArm);
}

function setupDocuments(): void {
  $('doc-tabs').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button[data-arm]') as HTMLButtonElement | null;
    if (b?.dataset.arm) { docArm = b.dataset.arm; renderDocument(); }
  });
  $('doc-prev').addEventListener('click', () => { docIndex--; renderDocument(); });
  $('doc-next').addEventListener('click', () => { docIndex++; renderDocument(); });
}

// ---- check a text
function runInput(): void {
  const input = $<HTMLTextAreaElement>('input');
  const text = input.value;
  if (!text.trim() || !current) { $('input-text').innerHTML = ''; $('input-found').innerHTML = ''; return; }
  const f = analyse(text);
  $('input-text').innerHTML = f.html;
  $('input-found').innerHTML = foundTable(current, f, null);
}

function setupInput(): void {
  let timer = 0;
  $('input').addEventListener('input', () => { clearTimeout(timer); timer = window.setTimeout(runInput, 150); });
}

// ---- switching the kind of writing

function captions(page: Page): void {
  const g = page.genre;
  const person = page.arms.find((a) => a.id === page.reference);
  const models = page.writers.filter((w) => w.id !== page.reference);
  const last = models[models.length - 1];
  $('genre-name').textContent = g.inText;
  const quoted = g.humanQuotable ? '' : ` The people’s ${esc(g.noun.many)} are counted, never quoted (${esc(g.source.licence)}).`;
  // a model's column is a subset once its cut-off, not-an-answer and remembered texts are dropped
  const fewer = models.some((w) => (page.arms.find((a) => a.id === w.id)?.n ?? 0) < (person?.n ?? 0));
  $('table-caption').innerHTML = `Every column up to ${esc(last?.short ?? 'the last model')} comes from the <b>same ${(person?.n ?? 0).toLocaleString('en')} ${esc(g.noun.many)}</b>: `
    + `written by a person (<a href="${esc(g.source.humanUrl)}" rel="noopener">${esc(g.source.human)}</a>), and written again by each model from the same prompt (<a href="https://github.com/liamdugan/raid">RAID</a>)`
    + `${fewer ? `; a model’s column has fewer where its texts were dropped (<a href="#method">how</a>)` : ''}. `
    + `A difference between those columns is about the writer, not the subject. Tinted cells are well above <span class="swatch up"></span> or below <span class="swatch down"></span> the person. `
    + `The last ${page.context.length} columns are for comparison: everyday casual writing, careful edited writing, and a chatbot answering questions.${quoted} Click a row to see what was counted.`;
  const claude = page.writers.find((w) => w.short.endsWith('*'));
  const off = page.rows.filter((r) => r.placeboTie === false).length;
  const placebo = off
    ? `the placebo check (the person’s ${g.noun.many} split at random) disagrees on ${off} row${off === 1 ? '' : 's'}, marked in the table`
    : `the placebo check (the person’s ${g.noun.many} split at random) ties on every row`;
  const claudeArm = claude && page.arms.find((a) => a.id === claude.id);
  $('table-foot').innerHTML = (claudeArm
    ? `* Claude was generated for this project (${claudeArm.n} ${esc(g.noun.many)}, reached through Claude Code) and the same system wrote this page; <a href="https://github.com/barbarkaragul-oss/is-it-really-an-ai-tell#a-claude-arm-generated-here">the caveats</a> matter. `
    : '') + `The verdict compares ${esc(g.deciderShort)} with the person; ${esc(placebo)}.`;
  $('cleaning-note').innerHTML = cleaningNote(page);
  const counts = page.arms.map((a) => `${esc(shortOf(a.id))} ${a.n.toLocaleString('en')}`).join(' · ');
  $('generated').innerHTML = `Measured ${esc(page.generated_at.slice(0, 10))}. Texts per arm in ${esc(g.inText)}: ${counts}.`;
}

/** what was dropped before this kind of writing was measured, in numbers */
export function cleaningNote(page: Pick<Page, 'cleaning' | 'genre'> & { writers: WriterInfo[] }): string {
  const c = page.cleaning;
  // the data was measured before the cleaning existed: the page must not claim it happened
  if (!c) return `The numbers shown for ${esc(page.genre.inText)} were measured before the cut-off, not-an-answer and dating checks existed; the next weekly measurement applies them.`;
  const name = (id: string): string => page.writers.find((w) => w.id === id)?.short ?? id;
  const parts: string[] = [];
  const d = c.dates;
  const many = page.genre.noun.many;
  if (d && (d.status === 'applied' || d.status === 'partial')) {
    const kept = [
      d.status === 'partial' ? `the dating is partial, and ${d.notLookedUp} not yet looked up are kept` : '',
      d.unmatched ? `${d.unmatched} could not be matched to a paper and are kept` : '',
    ].filter(Boolean).join('; ');
    parts.push(`${d.excluded} of ${d.documents} ${many} left out of every column because a version was posted after ChatGPT${kept ? ` (${kept})` : ''}`);
  } else if (d && (d.status === 'not applied' || d.status === 'unchecked')) {
    parts.push(`the dating of the ${many} is not applied yet`);
  }
  if (c.language?.excluded) {
    parts.push(`${c.language.excluded} of ${c.language.documents} ${many} left out of every column because one of the writers, the person or a model, wrote it in another language`);
  }
  const dropped = c.arms.filter((a) => a.truncated !== null)
    .map((a) => `${esc(name(a.arm))} ${a.truncated} cut off, ${a.meta} not an answer, ${a.remembered ?? 0} remembered`);
  if (dropped.length) parts.push(`texts dropped per model: ${dropped.join('; ')}`);
  const reported = c.arms.filter((a) => a.reported && (a.reported.truncated || a.reported.meta))
    .map((a) => `${esc(name(a.arm))}: ${a.reported!.truncated} would count as cut off and ${a.reported!.meta} as not an answer (reported, not dropped)`);
  parts.push(...reported);
  // each part after the first starts a sentence of its own
  const sentences = parts.map((p, i) => (i ? p.charAt(0).toUpperCase() + p.slice(1) : p));
  return parts.length ? `In ${esc(page.genre.inText)}: ${sentences.join('. ')}.` : '';
}

function load(id: string): Promise<Page> {
  let p = pages.get(id);
  if (!p) {
    const g = summary.genres.find((x) => x.id === id)!;
    p = fetch(g.file).then((res) => {
      if (!res.ok) throw new Error(String(res.status));
      return res.json() as Promise<Page>;
    });
    pages.set(id, p);
    p.catch(() => pages.delete(id));
  }
  return p;
}

/** the kind of writing asked for last; a slower load that finishes after a newer choice is dropped */
let wanted = '';

async function show(id: string, marker?: string): Promise<void> {
  wanted = id;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#genre-tabs button')) b.setAttribute('aria-selected', String(b.dataset.genre === id));
  let page: Page;
  try {
    page = await load(id);
  } catch (err) {
    if (wanted === id) $('markers').innerHTML = `<tbody><tr><td>The data did not load (${esc(String(err))}). The same numbers are in the repository's data folder.</td></tr></tbody>`;
    return;
  }
  if (wanted !== id) return;
  if (current?.genre.id !== page.genre.id) { docIndex = 0; docArm = page.reference; }
  current = page;
  renderTable(page);
  captions(page);
  renderDocument();
  runInput();
  if (marker) {
    const tr = document.querySelector<HTMLTableRowElement>(`#markers tr.row[data-marker="${CSS.escape(marker)}"]`);
    if (tr) { toggleRow(tr, true); tr.scrollIntoView({ block: 'center' }); tr.focus({ preventScroll: true }); }
  }
}

function pick(id: string, marker?: string): void {
  if (location.hash !== `#genre=${id}`) history.replaceState(null, '', `#genre=${id}`);
  void show(id, marker);
}

function setupSwitch(): void {
  $('genre-tabs').innerHTML = summary.genres.map((g) => `<button type="button" role="tab" data-genre="${esc(g.id)}" aria-selected="false">${esc(g.label)}</button>`).join('');
  $('genre-tabs').hidden = summary.genres.length < 2;
  $('genre-tabs').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button[data-genre]') as HTMLButtonElement | null;
    if (b?.dataset.genre) pick(b.dataset.genre);
  });
  const grid = $('grid');
  const open = (e: Event): void => {
    const t = e.target as HTMLElement;
    const cell = t.closest<HTMLElement>('td.gcell[data-genre]');
    const head = t.closest<HTMLElement>('button.glink[data-genre]');
    if (cell?.dataset.genre) pick(cell.dataset.genre, cell.dataset.marker);
    else if (head?.dataset.genre) { pick(head.dataset.genre); $('table-section').scrollIntoView(); }
  };
  grid.addEventListener('click', open);
  grid.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { if ((e.target as HTMLElement).matches('td.gcell')) { e.preventDefault(); open(e); } } });
  window.addEventListener('hashchange', () => {
    const id = genreFromHash(location.hash, summary.genres.map((g) => g.id));
    if (id && id !== current?.genre.id) void show(id);
  });
}

async function main(): Promise<void> {
  setupTheme();
  try {
    const res = await fetch('data/summary.json');
    if (!res.ok) throw new Error(String(res.status));
    summary = (await res.json()) as Summary;
  } catch (err) {
    $('grid').innerHTML = `<tbody><tr><td>The data did not load (${esc(String(err))}). The same numbers are in the repository's data folder.</td></tr></tbody>`;
    return;
  }
  renderGrid();
  setupSwitch();
  setupTable();
  setupDocuments();
  setupInput();
  const first = genreFromHash(location.hash, summary.genres.map((g) => g.id)) ?? summary.genres[0]?.id;
  if (first) await show(first);
}

if (typeof document !== 'undefined') void main();
