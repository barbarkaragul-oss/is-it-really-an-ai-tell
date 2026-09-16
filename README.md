# Is it really an AI tell?

People can tell you what gives away machine-written text. The em dash. The word *delve*. No contractions. Every list has three items.

Almost none of it is measured. This counts how often each of those markers appears in text that is human by construction, in text that is human *and careful*, and in machine text — and publishes the counts, the intervals and a placebo column, so that a marker can be argued with instead of repeated.

**The middle column is the point.** A marker that appears as often in careful human writing as in machine text is not a sign of a machine. It is a sign that somebody wrote carefully — which is exactly what a non-native speaker, a student on a good day, and a professional writer all look like.

> This is not a detector. It cannot tell you who wrote anything, and a text full of markers proves nothing. If you came here because software accused you of something, the useful number is in the other direction: published audits find AI detectors calling **17–19% of genuine human writing** machine-written ([untell](https://github.com/ssamba1/untell), [2026 detector benchmark](https://github.com/mattc95/2026-AI-DETECTOR-BENCHMARK)).

## What the first run shows

25 markers, 362 texts per arm after matching for length. Four markers separate the machine arm from careful human writing; two point the other way; the most famous words do not appear at all.

| marker | casual human | careful human | machine | verdict |
|---|---|---|---|---|
| “it is important to note” | 0.0% | 0.0% | **11.9%** | machine marker |
| every sentence the same length | 18.2% | 17.1% | **72.4%** | machine marker |
| a three-item list in one sentence | 8.0% | 9.1% | **22.9%** | machine marker |
| no first person\* | 21.5% | 30.4% | **93.6%** | machine marker |
| **an em dash** | 3.3% | **7.7%** | **0.0%** | **points the other way** |
| two or more em dashes | 2.2% | 3.0% | 0.0% | points the other way |
| no contractions\* | 21.0% | **37.6%** | 44.2% | register marker |
| no informal spelling\* | 92.5% | **98.9%** | 100.0% | register marker |
| “delve”, “tapestry”, “underscores”, “showcase”, “in today’s”, “dive into” | 0.0% | 0.0% | 0.0% | no signal |

\* a marker people are documented to judge by rather than one anybody measured ([Jakesch et al., PNAS 2023](https://www.pnas.org/doi/10.1073/pnas.2208839120)).

Three things worth reading twice:

- **The em dash, the most-repeated tell of all, is a careful-human marker here.** It shows up in 7.7% of edited Stack Exchange answers and in none of the machine texts.
- **Contractions mostly track register, not authorship.** Careful humans (37.6%) sit next to the machine (44.2%), far from casual humans (21.0%). Judging by contractions is judging how carefully somebody wrote.
- **First person is the belief that holds up.** Readers are right that machine text avoids “I”: 93.6% against 21.5%.

🔴 **The caveat that matters most.** The machine arm in this first run is HC3 — GPT-3.5, early 2023. The famous words are absent from it, and that is a fact about *that model*, not about machines. A 2024 arm (RAID's GPT-4 generations) is next, and the point of running both is that **the tells change with the model generation**: a word list assembled in 2023 measures a model nobody uses any more.

## The arms

| arm | what it is | why it is human, or not |
|---|---|---|
| casual human | Hacker News comments posted before **2022-11-30** | ChatGPT opened that day. The timestamp is the proof; no argument is possible. |
| careful human | Stack Exchange answers (english, academia, writing) from the same period | Human, and edited. This is the column that tells a machine marker from a careful-writing one. |
| machine 2023 | HC3 `chatgpt_answers`, CC BY-SA 4.0 | GPT-3.5. |
| machine 2024 | RAID `gpt4` generations, MIT | *next* |

## How the counting is done

Three choices make the numbers arguable rather than decorative.

1. **Length is held constant.** A marker that is merely *present* is easier to hit in a longer text, and the arms differ in length by a factor of two. Texts are binned by word count and every arm contributes the same number of texts to every bin. Anything that does not survive this was a length effect.
2. **There is a placebo arm.** One human corpus is split at random into halves and the whole pipeline runs on the pair. Every number in that column should be a tie. In the first run all 25 are — but an earlier version split the corpus by position instead of at random, which meant splitting it by *date*, and the placebo caught it. That is what the column is for.
3. **Intervals, and a correction.** Wilson intervals at 95%, and Benjamini–Hochberg across the whole catalogue, because testing two dozen markers at once produces a finding by luck otherwise.

## What is in this repository

- [`src/markers.ts`](src/markers.ts) — the catalogue. Every marker carries the source of the claim, so you can argue with the source rather than with me.
- [`src/measure.ts`](src/measure.ts) — intervals, length matching, placebo, correction.
- [`collector/fetch.ts`](collector/fetch.ts) — builds the corpora from their public APIs.
- [`data/markers.json`](data/markers.json) — the published numbers, re-measured weekly.

**The corpus text is not committed, and that is deliberate.** Hacker News licenses its content to Y Combinator, not to me, and Stack Exchange answers are CC BY-SA and would need attribution per answer. What ships is the ids and the counts; the fetch script rebuilds the exact corpus from them.

## Run it

```bash
git clone https://github.com/barbarkaragul-oss/is-it-really-an-ai-tell && cd is-it-really-an-ai-tell
npm install
npx tsx collector/fetch.ts --want 4000   # a few minutes; writes out/, which is gitignored
npx tsx scripts/measure-all.ts           # prints the table, writes data/markers.json
npm test
```

## Limits

- **A marker is presence, not frequency.** “Contains an em dash” ignores that one text has one and another has nine. Rates per thousand words come later.
- **362 texts an arm** after the length match, in this first run. That is enough to see a 70-point gap and not enough to argue about a 2-point one; the intervals say which is which.
- **Genre is not fully controlled.** Comments, answers and question-answering are not the same kind of writing. The careful-human arm exists to absorb part of that, and the RAID arm — where human and machine texts answer the *same* prompt — will absorb more.
- **One language.** English only.
- **Markers are regexes**, so “delve” catches the word and not the idea, and irony is invisible to all of it.
- **This cannot tell you who wrote a text**, and no amount of markers will make it able to.

## License

MIT. The corpora keep their own licences: HC3 is CC BY-SA 4.0, RAID is MIT, Hacker News and Stack Exchange content stays with its owners and is referenced by id only.
