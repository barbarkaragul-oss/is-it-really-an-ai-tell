/**
 * The page. Everything it counts in a pasted text is counted by src/markers.ts, the same code that
 * produced the table, and nothing typed here leaves the browser.
 */
import { MARKERS, byId, type Marker } from '../markers.js';

interface ArmInfo { id: string; label: string; kind: string; n: number; matched: number; medianWords: number; publishable: boolean; we: number }
interface RateCell { v: number; lo: number; hi: number; occ: number; words: number }
interface ShareCell { v: number; lo: number; hi: number; k: number; n: number; ref: number; rlo: number; rhi: number }
interface Row {
  marker: string; label: string; family: string; belief: boolean; countable: boolean; verdict: string; placeboTie: boolean;
  rate: Record<string, RateCell>; share: Record<string, ShareCell>;
}
interface Example { id: string; sentence?: string; link?: string }
interface Cell { occurrences: number; forms: [string, number][]; before: [string, number][]; examples: Example[] }
interface Doc { source_id: string; title: string; texts: Record<string, string> }
interface Page {
  generated_at: string; reference: string; machine: string;
  arms: ArmInfo[]; rows: Row[]; evidence: Record<string, Record<string, Cell>>; documents: Doc[];
}

const WRITERS = ['raid-human', 'raid-chatgpt', 'raid-gpt4', 'raid-llama-chat', 'raid-mistral-chat', 'raid-claude'];
const CONTEXT = ['casual-human', 'careful-human', 'hc3-gpt35'];
const PERSON = 'raid-human';
const SHORT: Record<string, string> = {
  'raid-human': 'Person', 'raid-chatgpt': 'GPT-3.5', 'raid-gpt4': 'GPT-4', 'raid-llama-chat': 'Llama', 'raid-mistral-chat': 'Mistral',
  'raid-claude': 'Claude*', 'casual-human': 'Casual writing', 'careful-human': 'Careful writing', 'hc3-gpt35': 'GPT-3.5 Q&A',
};
// what a column is, for its tooltip; the source is named, but it is not what the column stands for
const LONG: Record<string, string> = {
  'casual-human': 'Casual writing: everyday online comments posted before ChatGPT existed (source: Hacker News)',
  'careful-human': 'Careful writing: edited question-and-answer posts from the same period (source: Stack Exchange)',
  'hc3-gpt35': 'GPT-3.5 answering questions: a different task, kept for contrast (source: HC3)',
};
const VERDICT: Record<string, [cls: string, text: string, why: string]> = {
  'machine marker': ['machine', 'GPT-4 marker', 'GPT-4 uses it clearly more than the person writing the same abstract, and careful human writing does not account for it.'],
  'register marker': ['register', 'careful writing', 'The person and GPT-4 both use it far more than casual writers do. It marks how formally something is written, not who wrote it.'],
  'points the other way': ['other', 'more human', 'The person uses it more than GPT-4 does on the same documents.'],
  'no signal': ['none', 'no signal', 'No difference between the person and GPT-4 that the data can support.'],
  'not recorded': ['none', 'not recorded', ''],
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);
const short = (arm: string): string => SHORT[arm] ?? arm;

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

function rateCellHtml(row: Row, arm: string, tinted: boolean): string {
  const c = row.rate[arm];
  const p = row.rate[PERSON];
  const title = c ? `${c.occ} in ${c.words.toLocaleString('en')} words · 95% interval ${c.lo.toFixed(2)}–${c.hi.toFixed(2)}` : '';
  const style = tinted && c && p && arm !== PERSON ? tint(c.v, c.lo, c.hi, p.v, p.lo, p.hi, 0.02) : '';
  return `<td class="num${c && c.occ === 0 ? ' dim' : ''}" title="${esc(title)}" style="${style}">${fmtRate(c)}</td>`;
}

function shareCellHtml(row: Row, arm: string, tinted: boolean): string {
  const c = row.share[arm];
  const title = c ? `${c.k} of ${c.n} texts, length-matched with the person · 95% interval ${c.lo.toFixed(1)}–${c.hi.toFixed(1)}%` : '';
  const style = tinted && c && arm !== PERSON ? tint(c.v, c.lo, c.hi, c.ref, c.rlo, c.rhi, 1) : '';
  return `<td class="num" title="${esc(title)}" style="${style}">${fmtShare(c)}</td>`;
}

// ---- the table
function renderTable(page: Page): void {
  const present = new Set(page.arms.map((a) => a.id));
  const writers = WRITERS.filter((a) => present.has(a));
  const context = CONTEXT.filter((a) => present.has(a));
  const cols = writers.length + context.length + 2;
  const table = $('markers');
  const tip = (a: string): string => esc(LONG[a] ?? page.arms.find((x) => x.id === a)?.label ?? '');
  const head = `<thead><tr><th>Marker</th>${writers.map((a) => `<th title="${tip(a)}">${short(a)}</th>`).join('')}${context.map((a, i) => `<th class="ctx${i === 0 ? ' sep' : ''}" title="${tip(a)}">${short(a)}</th>`).join('')}<th>Verdict</th></tr></thead>`;
  const line = (row: Row): string => {
    const [cls, text, why] = VERDICT[row.verdict] ?? ['none', row.verdict, ''];
    const cell = row.countable ? rateCellHtml : shareCellHtml;
    return `<tr class="row" data-marker="${row.marker}" tabindex="0" aria-expanded="false">`
      + `<td>${esc(row.label)}${row.belief ? '<span class="belief" title="People are documented to judge by this one">people judge by it</span>' : ''}</td>`
      + writers.map((a) => cell(row, a, true)).join('')
      + context.map((a, i) => cell(row, a, false).replace('<td class="num', `<td class="ctx num${i === 0 ? ' sep' : ''}`)).join('')
      + `<td><span class="pill ${cls}" title="${esc(why)}">${text}</span></td></tr>`;
  };
  const counted = page.rows.filter((r) => r.countable);
  const whole = page.rows.filter((r) => !r.countable);
  table.innerHTML = head + '<tbody>'
    + `<tr class="group"><th colspan="${cols}">Words and phrases · occurrences per thousand words</th></tr>` + counted.map(line).join('')
    + `<tr class="group"><th colspan="${cols}">Properties of the whole text · share of texts</th></tr>` + whole.map(line).join('')
    + '</tbody>';

  const toggle = (tr: HTMLTableRowElement): void => {
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('detail')) {
      next.remove();
      tr.classList.remove('open');
      tr.setAttribute('aria-expanded', 'false');
      return;
    }
    const row = page.rows.find((r) => r.marker === tr.dataset.marker);
    if (!row) return;
    const detail = document.createElement('tr');
    detail.className = 'detail';
    detail.innerHTML = `<td colspan="${cols}"><div class="detail-inner"></div></td>`;
    tr.after(detail);
    tr.classList.add('open');
    tr.setAttribute('aria-expanded', 'true');
    renderDetail(detail.querySelector('.detail-inner') as HTMLElement, page, row, [...writers, ...context]);
  };
  table.addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest('tr.row');
    if (tr && !(e.target as HTMLElement).closest('a')) toggle(tr as HTMLTableRowElement);
  });
  table.addEventListener('keydown', (e) => {
    const tr = (e.target as HTMLElement).closest('tr.row');
    if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(tr as HTMLTableRowElement); }
  });
}

function renderDetail(box: HTMLElement, page: Page, row: Row, order: string[]): void {
  const m = byId.get(row.marker);
  const [, , why] = VERDICT[row.verdict] ?? ['', '', ''];
  const intro = `<p class="muted">${esc(why)}${m ? ` Claimed by: ${esc(m.source)}.` : ''}${m?.pattern ? ` Pattern: <code>${esc(m.pattern.source)}</code>` : ''}</p>`;
  const cells = page.evidence[row.marker] ?? {};
  const arms = order.filter((a) => cells[a]);
  if (!row.countable || !arms.length) {
    const note = row.countable
      ? 'No writer used it at all.'
      : 'This is a property of the whole text, so there is no sentence to show. Hover a number for how many texts it rests on.';
    box.innerHTML = `${intro}<p>${note}</p>`;
    return;
  }
  const writersFirst = arms.filter((a) => WRITERS.includes(a));
  let current = [...writersFirst].sort((a, b) => (cells[b]?.occurrences ?? 0) - (cells[a]?.occurrences ?? 0))[0] ?? arms[0]!;
  const draw = (): void => {
    const c = cells[current]!;
    const tabs = arms.map((a) => `<button type="button" role="tab" data-arm="${a}" aria-selected="${a === current}">${short(a)}<span class="n">${cells[a]!.occurrences}</span></button>`).join('');
    const forms = c.forms.length ? c.forms.map(([f, n]) => `<code>${esc(f)}</code> ${n}`).join(', ') : '<span class="muted">not shown for an arm that cannot be quoted</span>';
    const before = c.before.map(([f, n]) => `<code>${esc(f)}</code> ${n}`).join(', ');
    const examples = c.examples.map((x) => {
      if (x.sentence) return `<li>${markSentence(x.sentence, m)}</li>`;
      if (x.link) return `<li><a href="${esc(x.link)}" rel="noopener">${esc(x.link.replace(/^https:\/\//, ''))}</a> <span class="muted">(linked, not quoted)</span></li>`;
      return `<li class="muted">${esc(x.id)} (no public link; not quoted)</li>`;
    }).join('');
    box.innerHTML = `${intro}<div class="tabs" role="tablist">${tabs}</div>`
      + `<div class="facts"><span><b>Matched as</b> ${forms}</span><span><b>Word before</b> ${before}</span></div>`
      + `<ul class="examples">${examples}</ul>`;
  };
  box.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button[data-arm]') as HTMLButtonElement | null;
    if (b?.dataset.arm) { current = b.dataset.arm; draw(); }
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

interface Found { counts: Map<string, number>; whole: string[]; html: string; words: number }

function analyse(text: string): Found {
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
  const whole = MARKERS.filter((m) => !m.count && m.test(text)).map((m) => m.id);
  const words = (text.toLowerCase().match(/[a-z']+/g) ?? []).length;
  return { counts, whole, html, words };
}

function foundTable(page: Page, f: Found, writer: string | null): string {
  const rows = new Map(page.rows.map((r) => [r.marker, r]));
  const ctx = ['raid-human', 'raid-gpt4', 'casual-human', 'careful-human'].filter((a) => page.arms.some((x) => x.id === a));
  const extra = writer && !ctx.includes(writer) ? [writer] : [];
  const cols = [...ctx, ...extra];
  const counted = [...f.counts.entries()].filter(([id]) => rows.has(id));
  const whole = f.whole.filter((id) => rows.has(id));
  if (!counted.length && !whole.length) return '<p class="muted">None of the markers in the table occur in this text.</p>';
  let out = '';
  if (counted.length) {
    out += `<table><thead><tr><th>In this text</th><th>times</th>${cols.map((a) => `<th>${short(a)}</th>`).join('')}</tr></thead><tbody>`
      + counted.map(([id, n]) => {
        const r = rows.get(id)!;
        return `<tr><td>${esc(r.label)}</td><td>${n}</td>${cols.map((a) => `<td>${fmtRate(r.rate[a])}</td>`).join('')}</tr>`;
      }).join('')
      + `</tbody></table><p class="muted">The columns are occurrences per thousand words in each whole corpus. This text has ${f.words} words.</p>`;
  }
  if (whole.length) {
    out += `<table><thead><tr><th>True of this text</th>${cols.map((a) => `<th>${short(a)}</th>`).join('')}</tr></thead><tbody>`
      + whole.map((id) => {
        const r = rows.get(id)!;
        return `<tr><td>${esc(r.label)}</td>${cols.map((a) => `<td>${fmtShare(r.share[a])}</td>`).join('')}</tr>`;
      }).join('')
      + '</tbody></table><p class="muted">The columns are the share of texts in each corpus that have the same property. On a short text most of these hold by default.</p>';
  }
  return out;
}

// ---- one paper, six writers
function setupDocuments(page: Page): void {
  const section = $('doc-section');
  if (!page.documents.length) { section.hidden = true; return; }
  let di = 0;
  let arm = PERSON;
  const draw = (): void => {
    const d = page.documents[di]!;
    const writers = WRITERS.filter((a) => d.texts[a]);
    if (!writers.includes(arm)) arm = writers[0]!;
    $('doc-title').textContent = `“${d.title}” (${di + 1} of ${page.documents.length})`;
    $('doc-tabs').innerHTML = writers.map((a) => `<button type="button" role="tab" data-arm="${a}" aria-selected="${a === arm}">${short(a)}</button>`).join('');
    const f = analyse(d.texts[arm] ?? '');
    $('doc-text').innerHTML = f.html;
    $('doc-found').innerHTML = foundTable(page, f, arm);
  };
  $('doc-tabs').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button[data-arm]') as HTMLButtonElement | null;
    if (b?.dataset.arm) { arm = b.dataset.arm; draw(); }
  });
  $('doc-prev').addEventListener('click', () => { di = (di + page.documents.length - 1) % page.documents.length; draw(); });
  $('doc-next').addEventListener('click', () => { di = (di + 1) % page.documents.length; draw(); });
  draw();
}

// ---- check a text
function setupInput(page: Page): void {
  const input = $<HTMLTextAreaElement>('input');
  let timer = 0;
  const run = (): void => {
    const text = input.value;
    if (!text.trim()) { $('input-text').innerHTML = ''; $('input-found').innerHTML = ''; return; }
    const f = analyse(text);
    $('input-text').innerHTML = f.html;
    $('input-found').innerHTML = foundTable(page, f, null);
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = window.setTimeout(run, 150); });
}

async function main(): Promise<void> {
  setupTheme();
  let page: Page;
  try {
    const res = await fetch('data/page.json');
    if (!res.ok) throw new Error(String(res.status));
    page = (await res.json()) as Page;
  } catch (err) {
    $('markers').innerHTML = `<tbody><tr><td>The data did not load (${esc(String(err))}). The same numbers are in the repository's data folder.</td></tr></tbody>`;
    return;
  }
  renderTable(page);
  setupDocuments(page);
  setupInput(page);
  const date = page.generated_at.slice(0, 10);
  const counts = page.arms.map((a) => `${short(a.id)} ${a.n.toLocaleString('en')}`).join(' · ');
  $('generated').textContent = `Measured ${date}. Texts per arm: ${counts}.`;
}

void main();
