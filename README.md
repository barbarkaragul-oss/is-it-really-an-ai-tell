# Is it really an AI tell?

People can tell you what gives away machine-written text. The em dash. The word *delve*. No contractions. Every list has three items.

Almost none of it is measured. This counts each marker in one document written five ways — by a person, and by GPT-3.5, GPT-4, Llama chat and Mistral chat continuing that same document — and in casual and careful human writing from before ChatGPT existed. It publishes the rates, the intervals and a placebo column, so a marker can be argued with instead of repeated.

**[Open the page →](https://barbarkaragul-oss.github.io/is-it-really-an-ai-tell/)** Every number below, with the sentences behind it, one paper written six ways, and a box to paste your own text into. Nothing you paste leaves the browser.

[![The page: the table, a row opened to the sentences it counted, one paper written six ways, and a pasted text set against how often people use each marker](docs/demo.gif)](https://barbarkaragul-oss.github.io/is-it-really-an-ai-tell/)

> This is not a detector. It cannot tell you who wrote anything, and a text full of markers proves nothing. If software has accused you of something, the useful number points the other way: published audits find AI detectors calling **17–19% of genuine human writing** machine-written ([untell](https://github.com/ssamba1/untell), [2026 detector benchmark](https://github.com/mattc95/2026-AI-DETECTOR-BENCHMARK)).

## The findings

Occurrences per thousand words, on the full arms. RAID gives the same 1499 documents to every writer, so the columns differ by author and not by subject.

| marker | human | GPT-3.5 | **GPT-4** | Llama chat | Mistral chat |
|---|---|---|---|---|---|
| **“delve”** | 0.00 | 0.01 | **1.26** | 0.07 | 0.01 |
| “leverage” as a verb | 0.27 | 1.83 | 2.14 | 1.50 | 0.73 |
| “crucial” | 0.19 | 0.69 | 0.73 | 0.56 | 0.90 |
| **“moreover”** | **0.43** | 0.00 | 0.00 | 0.07 | 0.00 |
| “in conclusion” | 0.02 | 0.01 | 0.00 | **0.32** | 0.01 |
| an em dash | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |

**“Delve” is not an AI word. It is a GPT-4 word.** 1.26 per thousand (207 occurrences) against 0.07 for Llama, 0.01 for GPT-3.5 and 0.01 for Mistral — on the same documents. Everything written about that word describes one model.

**“Moreover” is a human word here.** A person writes it 0.43 times per thousand words (115 occurrences); every model in the table is at or near zero. The folklore has it backwards.

**“In conclusion” belongs to Llama** (0.32, 132 occurrences), not to the others. Several famous tells turn out to be one model's habit.

**“Leverage” as a verb is the marker that generalises**: every model runs 1.83–2.14 per thousand against 0.27 for the person writing the same document.

**The em dash appears in none of the five machine arms** — and in human writing at 0.27 per thousand in casual online comments and 0.48 in edited Q&A answers. Academic prose has none of it by either writer. Judging by em dashes is judging what kind of document you are reading.

### What the patterns actually caught

A rate says a pattern fired. [`data/evidence.json`](data/evidence.json) says what it fired on: for every countable marker and every arm, the forms that matched, the word in front of each match, and five sentences picked by a seeded shuffle rather than by anyone looking for good ones. Sentences are quoted only from RAID (MIT) and the Claude arm; the casual and careful writing is linked to where it was posted, not quoted.

Reading them turned up two things the rates hid.

**The models make the paper the subject.** When the people who wrote these abstracts used “leverage”, 22% of the time it was “leverage**s**”. For all four RAID models it is 83–86%, and the word in front is usually *method*, *approach* or *that*: “the proposed method leverages”. “Delve” has the same shape: 178 of GPT-4's 207 are “delves”, after *it*, *study* or *paper*. The humans write “we”, 14.41 times per thousand words, against **1.77** for GPT-4 on the same documents. Llama and Mistral write “we” about as often as people do (15.32 and 11.80) and still write “leverages”, so the two habits are related but not the same.

**GPT-4's lists of three are mostly one list.** “accuracy, robustness, and computational [efficiency]” appears 31 times in its 1,499 abstracts, with “accuracy, robustness, and efficiency” and “accuracy, efficiency, and robustness” close behind. The rule-of-three count there is measuring a template more than a rhythm.

Looking also fixed two labels. “Leverage” as a verb was counting the noun as well (“100x leverage” in an online comment); that only ever touched the casual and careful writing arms, while every RAID match is the verb. The hedging phrase has always counted “worth noting” too, and its label now says so.

### A correction worth stating plainly

An earlier version of this README, built when the only machine arm was HC3, reported “it is important to note” as the hedging formula that defined GPT-3.5. With RAID's GPT-3.5 arm answering the same documents, that phrase runs at **0.00 per thousand** — while HC3, which is GPT-3.5 *answering questions*, runs at **0.50**. So it is a habit of the assistant-answering-a-question task, not of the model. Matching the documents is what made the difference visible, and the earlier claim was wrong.

## A Claude arm, generated here

No public corpus contains Claude: it is not open-weight, so the benchmarks that get built from open
models pass it by. The gap is in the data rather than in the model, so this arm was generated for
this project — and that makes it different from every other arm in the table, in ways worth stating
before the numbers.

**What was done.** RAID publishes the prompt it gave each model. The same 150 prompts were handed to
Claude verbatim, one call per document, with one instruction added because the pipeline needs a bare
string back: *“Return only the abstract text itself.”* No style instruction, no examples, nothing
discarded. Every returned text is in
[`data/generated/claude-abstracts.json`](data/generated/claude-abstracts.json) with its prompt.

**Four things that make this arm weaker than the others, in order of how much they matter.**

1. **The model was asked to write abstracts of real papers, and sometimes it remembered them.**
   Five of the fifty texts reproduce the published abstract almost word for word — one of them
   exactly. Those are human writing wearing a machine label, and they are excluded from the
   measurement; the check is [`scripts/contamination.ts`](scripts/contamination.ts) and it runs
   against every machine arm, not only this one. RAID's own arms come out clean: GPT-4 overlaps the
   human document by 0.5% and GPT-3.5 by 0.8%, against **14.3%** here. That difference is probably
   about training cutoffs — these papers are older to a 2026 model than they were to a 2023 one —
   and it is a warning for anyone building a corpus this way today.
2. **The generator and the author of this repository are the same system.** The text was produced by
   Claude, and Claude wrote the code that measures it. The prompt is RAID's own and no output was
   selected or rejected, but a model asked to write while knowing its style will be measured is not
   in the same position as one simply doing the task.
3. **It was reached through Claude Code, not a bare API call**, so a system prompt was in context.
   What is measured is a model inside a product, which is how most people meet one, but it is not
   the same thing as the model alone.
4. **45 texts against 1,499 in the other arms**, all of them academic abstracts. The intervals are
   correspondingly wide.

**What the numbers say.** On the same 150 documents, per thousand words:

| marker | human | GPT-3.5 | GPT-4 | **Claude** |
|---|---|---|---|---|
| “delve” | 0.00 | 0.00 | 0.18 | **0.00** |
| “leverage” as a verb | 0.63 | 3.70 | 3.91 | **0.18** |
| “crucial” | 0.46 | 0.89 | 0.77 | **0.18** |
| “furthermore” | 0.40 | 0.47 | 0.77 | **0.09** |
| “moreover” | 0.53 | 0.00 | 0.00 | **0.35** |
| **an em dash** | **0.00** | **0.00** | **0.00** | **0.53** |

On the vocabulary everybody calls an AI tell, this arm sits *below* the human academic baseline:
“leverage” at 0.18 against the person's 0.63 and GPT-4's 3.91, “crucial” and “furthermore” likewise.
It also writes “moreover” at roughly the human rate, where both GPT models write it never.

And it is the only writer in the study that used an em dash at all: three of its forty-five texts,
against none in 150 human abstracts, 150 from GPT-3.5 and 150 from GPT-4. Three texts is not much to
stand on — but if the em dash is anybody's tell, it is not the tell of the models that were measured
before this one.

## Shares, for the markers you cannot count

Some markers are properties of a whole text — “every sentence the same length”, “no contractions anywhere” — and a rate per thousand words means nothing for them. Those are reported as the share of texts that carry it, with each arm paired against the human reference (the kind and n of each pairing are in [`data/markers.json`](data/markers.json)).

| marker | casual writing | careful writing | human (RAID) | GPT-3.5 | GPT-4 | verdict |
|---|---|---|---|---|---|---|
| every sentence the same length | 20.4% | 19.8% | 64.2% | 96.1% | **94.1%** | machine marker |
| no first person\* | 18.0% | 29.2% | 89.3% | 99.7% | **100.0%** | machine marker |
| a three-item list in one sentence | 10.2% | 9.9% | 14.9% | 7.9% | 21.3% | machine marker |
| no contractions\* | 17.8% | 31.8% | 89.3% | 95.4% | 85.0% | register marker |
| no informal spelling\* | 92.7% | 98.6% | 100.0% | 100.0% | 100.0% | register marker |

\* a marker people are documented to judge by rather than one anybody measured ([Jakesch et al., PNAS 2023](https://www.pnas.org/doi/10.1073/pnas.2208839120)).

**Contractions are the belief that fails**: careful writers (31.8%) and the human academic arm (89.3%) sit beside the machines, far from casual writing (17.8%). Judging by contractions is judging how carefully somebody wrote. **First person is the belief that holds**: 100.0% of GPT-4 texts avoid “I” against 18.0% of casual ones.

## The arms

| arm | what it is | texts |
|---|---|---|
| casual writing | everyday online comments posted before **2022-11-30**, the day ChatGPT opened (source: Hacker News) | 4000 |
| careful writing | edited question-and-answer posts from the same period (source: Stack Exchange: english, academia, writing) | 4002 |
| human (RAID) | the human documents every model was asked to continue | 1499 |
| GPT-3.5, GPT-4, Llama chat, Mistral chat | [RAID](https://github.com/liamdugan/raid) continuations of those same documents, unattacked rows only | 1499 each |
| HC3 | GPT-3.5 answering questions — a different task, kept as the contrast that produced the correction above | 4000 |

RAID's adversarial rows — homoglyphs, inserted whitespace, deliberate misspellings — are excluded; measuring style markers there would measure the attack.

## How the counting is done

1. **Two measures, each for the kind of marker it suits, and each decides its own verdict.** A word or phrase becomes occurrences per thousand words over every text in the arm. That rate still depends on length: a phrase used once in a text has half the rate in a text twice as long, and GPT-4 wrote its abstracts nearly 40% shorter than the people did (a median of 109 words against 175). So the table shows the whole-arm rates, but the verdict compares GPT-4 with the person only between texts within a tenth of each other in length. A property of the whole text cannot be counted that way, so it is a share, and for a share length is controlled by the pairing.
2. **Length is controlled pairwise, and the pairs are not the file's order.** Matching eight arms at once cuts every arm down to the smallest one in every bin; the first attempt at this collapsed a 1,499-text arm to 123. Each arm is matched against the human reference on its own instead. A RAID model's text is paired with the human text for the same document, and the pair is kept only when both fall in the same length bin. Casual writing, careful writing and HC3 share no documents with the reference, so each of their bins is filled from a seeded shuffle. The corpora are stored grouped by topic, and an earlier version that took the first texts of every bin was comparing one topic with another. Every pairing publishes its kind and its n.
3. **A text a marker cannot judge is left out, not counted as a no.** “Every sentence the same length” says nothing about a text with fewer than five sentences, so such a text is dropped from that marker's shares on both sides of a pairing.
4. **The writer's own words.** Block quotes, quoted lines and code are removed from the casual and careful writing before anything is counted, and a span in double quotes does not count towards the three belief markers (contractions, first person, personal detail). RAID's human abstracts come wrapped at 79 columns and the models' texts do not, so those line breaks are joined before counting; left in, they hid a phrase from its pattern on the human side only.
5. **A placebo arm.** The reference corpus is split at random and the same tests run on both halves. Every number there should be a tie; all 25 are. An earlier version split by position, which meant splitting by date, and the placebo disagreed until the split was randomised.
6. **Intervals, and a correction.** Wilson intervals for shares. Exact Poisson intervals for rates, and an exact test between them, both widened when writers repeat a word within one text, because those occurrences are not independent. Benjamini–Hochberg across the catalogue, and a word's verdict needs its rate test to survive it.

## Run it

```bash
git clone https://github.com/barbarkaragul-oss/is-it-really-an-ai-tell && cd is-it-really-an-ai-tell
npm install
npx tsx collector/fetch.ts --want 4000        # Hacker News, Stack Exchange, HC3
npx tsx collector/fetch-raid.ts --want 1500   # one document, five writers
npx tsx scripts/contamination.ts               # drops machine texts that reproduce the human document
npx tsx scripts/measure-all.ts                # prints both tables, writes data/markers.json
npx tsx scripts/evidence.ts                   # what each pattern matched, writes data/evidence.json
npm run build                                 # the site, into docs/
npm test
```

**The corpus text is not committed, deliberately.** Hacker News licenses its content to Y Combinator and Stack Exchange answers are CC BY-SA. What ships is ids and counts; the fetch scripts rebuild the exact corpus. RAID is 2.3 GB across ten parquet shards and none of it is downloaded whole: row-group statistics say which groups can hold the wanted rows, and only those are fetched over HTTP range requests, paced so the host does not have to refuse.

## Limits

- **Five writers, and one of them is this repository's own.** Four come from a published benchmark; the Claude arm was generated here, is a tenth of the size, and carries the caveats in its own section. No Gemini at all.
- **One genre for the matched set, one source for each comparison.** The matched documents are academic abstracts; casual and careful writing are there to show how much of a marker is really about the kind of text, but they are not matched by document and each comes from a single site. Essays, email and social posts are not in yet.
- **Markers are regexes.** “Delve” catches the word and not the idea, and irony is invisible to all of it.
- **Presence and rate disagree sometimes.** For a word, the verdict follows the rate compared at equal lengths; a whole-arm rate can still lean on GPT-4's shorter texts, and a word that only the short texts use has little to be compared with.
- **English only.**
- **This cannot tell you who wrote a text**, and no number of markers will make it able to.

## License

MIT. The corpora keep their own licences: HC3 is CC BY-SA 4.0, RAID is MIT, Hacker News and Stack Exchange content stays with its owners and is referenced by id only.
