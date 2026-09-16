/**
 * What a marker actually matched.
 *
 * A rate says a regex fired 351 times. It does not say on what, and "leverage" the verb, "leverage"
 * the noun and "leveraged" the buyout are one regex away from each other. So for every countable
 * marker this collects the forms that matched, the word in front of each match, and a handful of
 * the sentences themselves, picked by a seeded shuffle rather than by anyone looking for good ones.
 */
import type { Marker } from './markers.js';
import { seededShuffle, type Text } from './measure.js';

export interface Hit { id: string; form: string; before: string; sentence: string }

/** the sentence around a match, cut to `max` characters with the match kept in view */
export function sentenceAround(text: string, start: number, end: number, max = 240): string {
  let from = start, to = end;
  while (from > 0 && !/[.!?\n]/.test(text[from - 1]!)) from--;
  while (to < text.length && !/[.!?\n]/.test(text[to]!)) to++;
  if (to < text.length) to++;
  const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const raw = text.slice(from, to);
  if (flat(raw).length <= max) return flat(raw);
  // too long: a window of the raw sentence centred on the match
  const half = Math.max(0, Math.floor((max - (end - start)) / 2));
  const b = Math.min(raw.length, Math.max(0, start - from - half) + max);
  const a = Math.max(0, b - max);
  return (a > 0 ? '…' : '') + flat(raw.slice(a, b)) + (b < raw.length ? '…' : '');
}

export function hits(texts: Text[], m: Marker): Hit[] {
  if (!m.pattern) return [];
  const out: Hit[] = [];
  for (const t of texts) {
    for (const x of t.text.matchAll(m.pattern)) {
      const start = x.index, end = start + x[0].length;
      const before = (t.text.slice(Math.max(0, start - 40), start).toLowerCase().match(/([a-z][a-z'-]*)[^a-z]*$/)?.[1]) ?? '';
      out.push({ id: t.id, form: x[0].toLowerCase(), before, sentence: sentenceAround(t.text, start, end) });
    }
  }
  return out;
}

/** the n most frequent values, most frequent first, ties broken alphabetically so the output is stable */
export function top(values: string[], n: number): [string, number][] {
  const c = new Map<string, number>();
  for (const v of values) if (v) c.set(v, (c.get(v) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}

/**
 * The forms that matched, as far as they may be shown. For an open-ended pattern the match is a
 * piece of the writer's text ("not only … but also" with whatever sits between), so an arm that
 * cannot be quoted shows none of those; a fixed phrase is not anybody's text and is always shown.
 */
export function forms(all: Hit[], quotable: boolean, openEnded: boolean, n = 8): [string, number][] {
  if (openEnded && !quotable) return [];
  return top(all.map((h) => h.form), n);
}

/** examples that nobody chose: a seeded shuffle of every hit, at most one per document */
export function examples(all: Hit[], n: number, seed: number): Hit[] {
  const seen = new Set<string>();
  const out: Hit[] = [];
  for (const h of seededShuffle(all, seed)) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    out.push(h);
    if (out.length === n) break;
  }
  return out;
}

/**
 * Where a reader can see a text we are not allowed to quote. Decided by the arm, not by the shape of
 * the id: a Hacker News item and a Stack Exchange answer are both plain numbers, and an answer
 * number means nothing without its site.
 */
export function linkFor(arm: string, id: string): string | null {
  if (arm === 'casual-human' && /^\d+$/.test(id)) return `https://news.ycombinator.com/item?id=${id}`;
  const se = id.match(/^(english|academia|writing):(\d+)$/);
  if (arm === 'careful-human' && se) return `https://${se[1]}.stackexchange.com/a/${se[2]}`;
  return null;
}
