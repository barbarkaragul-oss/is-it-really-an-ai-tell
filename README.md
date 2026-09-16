# Is it really an AI tell?

People can tell you what gives away machine-written text. The em dash. The word *delve*. No contractions. Every list has three items.

Almost none of it is measured. This counts how often each marker appears in text that is human by construction, in text that is human *and* careful, and in machine text — and publishes the rates, the intervals and a placebo column, so a marker can be argued with instead of repeated.

**Two columns do the work.** One is careful human writing: a marker as common there as in machine text marks *care*, not a machine — which is what a non-native speaker, a student on a good day and a professional writer all look like. The other is a matched pair: RAID gives the human document and the GPT-4 continuation of that same document, so genre, topic and prompt are held constant and only the writer changes.

> This is not a detector. It cannot tell you who wrote anything, and a text full of markers proves nothing. If software has accused you of something, the useful number points the other way: published audits find AI detectors calling **17–19% of genuine human writing** machine-written ([untell](https://github.com/ssamba1/untell), [2026 detector benchmark](https://github.com/mattc95/2026-AI-DETECTOR-BENCHMARK)).

## The finding

**The tells belong to a model generation, not to machines.** Run the same 25 markers against GPT-3.5 (2023) and GPT-4 (2024) and almost none of them hold in both.

| marker | GPT-3.5 (2023) | GPT-4 (2024) |
|---|---|---|
| “it is important to note” | **12.5%** | 0.0% |
| “delve” | 0.0% | **4.2%** |
| “leverage” as a verb | 0.0% | **31.1%** |
| “showcase” | 0.0% | **4.2%** |

The hedging formula that defined 2023 is gone; the vocabulary everybody now quotes belongs to the model that replaced it. A word list assembled in 2023 measures a model nobody runs.

## The table

Matched for length, 312 texts per arm. `raid-human` and `gpt-4` are the same documents, written by a person and continued by a model.

| marker | casual human | careful human | **raid-human** | **GPT-4** | verdict |
|---|---|---|---|---|---|
| “leverage” as a verb | 0.3% | 0.0% | 3.8% | **31.1%** | machine marker |
| every sentence the same length | 20.2% | 18.9% | 59.0% | **93.6%** | machine marker |
| a three-item list in one sentence | 7.1% | 7.4% | 11.5% | **26.3%** | machine marker |
| “delve” | 0.0% | 0.0% | 0.0% | **4.2%** | machine marker |
| “showcase” | 0.3% | 0.0% | 0.6% | **4.2%** | machine marker |
| no first person\* | 23.4% | 33.7% | 92.9% | **99.7%** | machine marker |
| **“moreover”** | 0.0% | 0.6% | **14.7%** | 1.0% | **points the other way** |
| “crucial” | 0.3% | 0.0% | 7.7% | 9.3% | register marker |
| “furthermore” | 0.3% | 0.3% | 4.5% | 7.4% | register marker |
| no contractions\* | 22.8% | 36.9% | 90.4% | 84.6% | register marker |
| **an em dash** | 3.5% | **8.3%** | 0.0% | 0.0% | genre, not authorship |
| “tapestry”, “in today’s”, “dive into”, Title Case headings | 0.0% | 0.0% | 0.0% | 0.0% | no signal |

\* a marker people are documented to judge by rather than one anybody measured ([Jakesch et al., PNAS 2023](https://www.pnas.org/doi/10.1073/pnas.2208839120)).

Four things worth reading twice:

- **“Moreover” points the other way.** In academic prose a person writes it in 14.7% of documents and GPT-4 in 1.0%. The folklore has it backwards.
- **“Crucial” and “furthermore” are register markers.** Both rise in careful human writing *and* in machine text, and sit near zero in casual comments. They mark the register, not the writer.
- **The em dash is about genre.** 8.3% of edited Stack Exchange answers carry one; academic abstracts carry none, by a person (0.0%) or by GPT-4 (0.0%). Judging by em dashes is judging what kind of document you are reading.
- **“Leverage” as a verb is the strongest single word here**: 31.1% against 3.8% for the same documents written by people.

Contractions are the belief that fails and first person is the belief that holds: readers are right that machine text avoids “I” (99.7% against 23.4%), and wrong that contractions tell them much once they account for how carefully the text was written.

## The arms

| arm | what it is | why it is human, or not |
|---|---|---|
| casual human | Hacker News comments posted before **2022-11-30** | ChatGPT opened that day. The timestamp is the proof. |
| careful human | Stack Exchange answers (english, academia, writing) from the same period | Human, and edited. |
| raid-human | the human documents in [RAID](https://github.com/liamdugan/raid) (news, abstracts, books, poetry) | Human, and the exact documents the model was asked to continue. |
| machine 2023 | HC3 `chatgpt_answers`, CC BY-SA 4.0 | GPT-3.5. |
| machine 2024 | RAID `gpt4`, unattacked rows only, MIT | GPT-4, on the same prompts as raid-human. |

RAID's adversarial rows — homoglyphs, inserted whitespace, deliberate misspellings — are excluded. Measuring style markers on those would measure the attack.

## How the counting is done

1. **Length is held constant.** A marker that is merely *present* is easier to hit in a longer text, and the arms differ in length by a factor of two. Texts are binned by word count and every arm contributes the same number to every bin. Anything that does not survive was a length effect.
2. **There is a placebo arm.** One human corpus is split at random and the whole pipeline runs on both halves. Every number there should be a tie; all 25 are. An earlier version split by position, which meant splitting by date, and the placebo disagreed until the split was randomised. That is what the column is for.
3. **Intervals, and a correction.** Wilson intervals at 95%, Benjamini–Hochberg across the catalogue, because testing two dozen markers at once produces a finding by luck otherwise.

## What is in this repository

- [`src/markers.ts`](src/markers.ts) — the catalogue; every marker carries the source of the claim.
- [`src/measure.ts`](src/measure.ts) — intervals, length matching, placebo, correction.
- [`collector/fetch.ts`](collector/fetch.ts), [`collector/fetch-raid.ts`](collector/fetch-raid.ts) — the corpora, from public APIs and published parquet.
- [`data/markers.json`](data/markers.json) — the numbers, re-measured weekly.

**The corpus text is not committed, deliberately.** Hacker News licenses its content to Y Combinator and Stack Exchange answers are CC BY-SA. What ships is ids and counts; the fetch scripts rebuild the exact corpus.

RAID is 2.3 GB across ten parquet shards and none of it is downloaded whole: each shard's row-group statistics say which groups can hold the rows wanted, and only those are fetched over HTTP range requests, paced so the host does not have to refuse.

## Run it

```bash
git clone https://github.com/barbarkaragul-oss/is-it-really-an-ai-tell && cd is-it-really-an-ai-tell
npm install
npx tsx collector/fetch.ts --want 4000        # Hacker News, Stack Exchange, HC3
npx tsx collector/fetch-raid.ts --want 2500   # RAID's matched pairs
npx tsx scripts/measure-all.ts                # prints the table, writes data/markers.json
npm test
```

## Limits

- **A marker is presence, not frequency.** “Contains an em dash” ignores that one text has one and another has nine. Rates per thousand words come next.
- **312 texts an arm** after the length match. Enough for a 70-point gap, not for a 2-point one; the intervals say which is which.
- **Two length bins survive the match**, because GPT-4's generations are short. Longer machine text would widen it.
- **Two model generations, four corpora, one language.** No Claude, no Gemini, no Llama here yet, and English only.
- **Markers are regexes**, so “delve” catches the word and not the idea, and irony is invisible to all of it.
- **This cannot tell you who wrote a text**, and no number of markers will make it able to.

## License

MIT. The corpora keep their own licences: HC3 is CC BY-SA 4.0, RAID is MIT, Hacker News and Stack Exchange content stays with its owners and is referenced by id only.
