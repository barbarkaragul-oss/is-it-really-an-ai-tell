# Is it really an AI tell?

People can tell you what gives away machine-written text. The em dash. The word *delve*. No contractions. Every list has three items.

Almost none of it is measured. This counts each marker in one document written five ways — by a person, and by GPT-3.5, GPT-4, Llama chat and Mistral chat continuing that same document — and in casual and careful human writing from before ChatGPT existed. It publishes the rates, the intervals and a placebo column, so a marker can be argued with instead of repeated.

**[Open the page →](https://barbarkaragul-oss.github.io/is-it-really-an-ai-tell/)** Every number below, with the sentences behind it, one paper written six ways, and a box to paste your own text into. Nothing you paste leaves the browser.

[![The page: the table, a row opened to the sentences it counted, one paper written six ways, and a pasted text set against how often people use each marker](docs/demo.gif)](https://barbarkaragul-oss.github.io/is-it-really-an-ai-tell/)

> This is not a detector. It cannot tell you who wrote anything, and a text full of markers proves nothing. If software has accused you of something, the useful number points the other way: published audits find AI detectors calling **17–19% of genuine human writing** machine-written ([untell](https://github.com/ssamba1/untell), [2026 detector benchmark](https://github.com/mattc95/2026-AI-DETECTOR-BENCHMARK)).

## The findings

Occurrences per thousand words, on the full arms. RAID gives the same 1,500 documents to every writer, so the columns differ by author and not by subject. The verdict compares GPT-4 with the person at equal text lengths (see [How the counting is done](#how-the-counting-is-done)).

| marker | human | GPT-3.5 | **GPT-4** | Llama chat | Mistral chat | verdict for GPT-4 |
|---|---|---|---|---|---|---|
| **“delve”** | 0.00 | 0.01 | **1.26** | 0.07 | 0.01 | machine marker |
| “leverage” as a verb | 0.27 | 1.83 | 2.14 | 1.49 | 0.73 | machine marker |
| “crucial” | 0.19 | 0.69 | 0.74 | 0.56 | 0.90 | machine marker |
| a three-item list | 1.63 | 2.01 | 5.25 | 4.82 | 2.92 | machine marker |
| “furthermore” | 0.33 | 0.39 | 0.34 | 0.32 | 0.06 | register marker |
| **“moreover”** | **0.43** | 0.00 | 0.00 | 0.07 | 0.00 | points the other way |
| “in conclusion” / “in summary” / “to sum (it) up” | 0.01 | 0.01 | 0.00 | **0.32** | 0.01 | no signal |
| **a dash, however it is typed** | **0.32** | 0.00 | 0.03 | 0.01 | 0.00 | points the other way |

**“Delve” is not an AI word. It is a GPT-4 word.** 1.26 per thousand (207 occurrences) against 0.07 for Llama (27), 0.01 for GPT-3.5 and 0.01 for Mistral (2 each), and none at all from the people writing the same documents. On the documents where GPT-4 and the person wrote abstracts of similar length, 51 of GPT-4's 252 use it and none of the person's do. Everything written about that word describes one model.

**“Moreover” is a human word here.** A person writes it 0.43 times per thousand words (115 occurrences, in 7.4% of the abstracts). GPT-3.5, GPT-4 and Mistral never write it, and Llama writes it 0.07 times per thousand. The folklore has it backwards.

**“In conclusion” belongs to Llama** (0.32, 132 occurrences: 81 “in summary” and 51 “in conclusion”), not to the other models, which use it twice at most or never (the person writing the same documents uses it 4 times). Several famous tells turn out to be one model's habit.

**“Leverage” as a verb and “crucial” are the words that generalise across the four RAID models.** All four write “leverage” more often than the person writing the same document, from 0.73 (Mistral) to 2.14 (GPT-4) per thousand against 0.27, and “crucial” from 0.56 to 0.90 against 0.19. Every RAID model's interval sits above the person's on both words. The Claude arm does not follow them (see [its section](#a-claude-arm-generated-here)).

**“Furthermore” belongs to the kind of writing, not to the machine.** The person and three of the models write it at about the same rate (0.32–0.39 per thousand), while casual and careful writing barely use it (0.02 and 0.03).

**GPT-4 and Llama write about three times as many three-item lists as the person** (5.25 and 4.82 per thousand against 1.63). GPT-3.5 is close to the person (2.01). People write these lists everywhere: 1.22 per thousand in casual writing and 1.55 in careful writing. Some of what this count catches is a template; see below.

**The dash points the other way.** Counted however it is typed, the people use dashes and the four RAID models barely do. The 1,500 human abstracts hold 85 dashes (0.32 per thousand, in 58 abstracts), and not one of them is the “—” character. RAID's abstracts come from TeX, and of those 85, 38 are a hyphen with spaces around it, 28 are “--” and 19 are “---”. Between them, the four RAID models wrote 11 dashes in 6,000 abstracts (GPT-4 5, Llama 6, GPT-3.5 and Mistral none), all of them spaced hyphens. Across the 1,710 document pairs of the four models, the model's abstract has a dash in 2 and the person's in 70. Compared at equal lengths, GPT-4 has 5 of the dashes where equal habits would have given it about 11. The gap is real but narrower than the whole-arm rates suggest. The dash is mostly about the kind of writing: casual writing uses 2.12 per thousand and careful writing 1.94, more than six times the abstracts' rate. Judging by dashes is judging what kind of document you are reading, and in these documents it is the people, not the four RAID models, who use them. The Claude arm writes more dashes than the person, on few texts; see [its section](#a-claude-arm-generated-here).

### What the patterns actually caught

A rate says a pattern fired. [`data/evidence.json`](data/evidence.json) says what it fired on: for every countable marker and every arm, the forms that matched, the word in front of each match, and five sentences picked by a seeded shuffle rather than by anyone looking for good ones. Sentences are quoted only from RAID (MIT) and the Claude arm; the casual and careful writing is linked to where it was posted, not quoted.

Reading them turned up two things the rates hid.

**The models make the paper the subject.** When the people who wrote these abstracts used “leverage”, 22% of the time it was “leverage**s**” (16 of 74). For all four RAID models it is 83–86%, and the word in front is usually *method*, *approach* or *that*: “the proposed method leverages”. “Delve” has the same shape: 178 of GPT-4's 207 are “delves”, and the word in front is most often *it* (60), *study* (46) or *paper* (37). The people write “we” 14.40 times per thousand words, against **1.77** for GPT-4 on the same documents. Llama and Mistral write “we” about as often as people do (15.32 and 11.80) and still write “leverages”, so the two habits are related but not the same.

**GPT-4 repeats its lists of three.** “accuracy, robustness, and computational …” (usually *efficiency*) appears 31 times in its 1,500 abstracts, with “accuracy, robustness, and efficiency” (8) and “accuracy, efficiency, and robustness” (6) behind it. Now that the middle item of a list can be several words long (before a serial comma), a second template shows up: “computer vision, medical imaging, and remote sensing” 14 times, and the same three in another order 10 more. Llama does the same (“diagnosis, treatment planning, and monitoring”, 32 times). No list in the person's abstracts appears more than twice. Those two templates are 69 of GPT-4's 862 lists, so they are not the whole count, but part of what the rule-of-three count measures there is a template rather than a rhythm.

Looking also fixed two labels. “Leverage” as a verb was counting the noun as well, in a few online comments; that only ever touched the casual and careful writing arms, while every RAID match is the verb. The hedging phrase has always counted “worth noting” too, and its label now says so.

### Corrections, 16 September

In the first published version of these findings, some patterns counted the wrong thing, mostly the way the source files were typed rather than the writers, and some comparisons set texts from different documents against each other. Reviews of the published numbers found these problems. The patterns and the pairing were fixed (commit `5e26cb8`) and the weekly job measured everything again. This is what the first version got wrong, with its numbers next to the current ones.

1. **“No first person” counted “(i)” and “i.e.” as “I”.** The pattern ignored case, so the “(i)” of a list and the “i” of “i.e.” counted as “I”. It also took any standalone “I”, so Roman numerals (“Type I”), single-letter variables and initials counted too. The first version found first person in 10.7% of the human abstracts (161 of 1,499). Counting only first-person pronouns, it is 0.7% (10 of 1,500). GPT-4 still never uses it, but it is no longer set apart from the person (100% against 98.8% on the same documents), and the verdict moved from machine marker to register marker.
2. **The dash counted only as the “—” character.** RAID's human abstracts are plain ASCII from TeX, where a dash is typed “---”, “--” or as a hyphen with spaces. The first version reported 0.00 dashes per thousand words for the people and, in the Claude section, “none in 150 human abstracts”. Counted however it is typed, there are 85 in 1,500 abstracts (0.32 per thousand), and the verdict moved from no signal to points the other way. Casual and careful writing went from 0.27 and 0.48 per thousand to 2.12 and 1.94.
3. **“No contractions” counted the possessive ’s.** “the model's” was read as a contraction. The first version had 89.3% of the human abstracts and 85.0% of GPT-4's free of contractions, which looked like a gap between them. Without possessives, the figures are 99.6% and 100%. Abstracts have no contractions, whoever writes them.
4. **The pairs were not the same documents.** Whole-text markers are compared on pairs of texts of similar length. The first version took the first texts of each length bin in file order, and RAID's file is grouped by topic, so a model's abstracts were set against the person's abstracts of other papers. Each model's text is now paired with the human abstract of the same document. “Crucial” shows the effect most clearly. On the old pairs, GPT-4 used it in 10.1% of abstracts and the person in 5.2%, the intervals overlapped (7.2–14.2% and 3.2–8.5%), and the verdict was register marker. On the same documents it is 8.3% against 2.0% (5.5–12.4% and 0.9–4.6%), the rate test at equal lengths agrees (q = 0.0001), and it is a machine marker.
5. **The Claude section had the same flaw, and two wrong statements.** It said 150 of RAID's prompts were given to Claude, when 50 were, and that no output was selected or rejected, when five were left out for reproducing the published abstract. Its table set Claude's 45 texts against the other writers' rates on 150 documents, so, as in point 4, it compared different documents. Every writer is now counted on the same 45 documents ([`data/claude-matched.json`](data/claude-matched.json)). Claude's place next to the person did not change on “leverage”, “crucial” and “furthermore” (below) or on “moreover” (a little below). What changed for the dash is in point 2.

Other patterns were tightened or widened in the same pass. The hedging phrase now allows an adverb or a modal in the middle. That raised its rate in HC3 from 0.50 to 0.65 per thousand: 113 of the 481 matches there have “also” in the middle, which the old pattern missed. RAID's GPT-3.5 stays at 0.00. “To sum up” counts only as a wrap-up. Three-item lists now take “or” and, before a serial comma, a middle item of several words; their count rose in every arm, by 1.6 to 2.5 times (the person from 1.01 to 1.63 per thousand, GPT-4 from 2.19 to 5.25). A year no longer counts as personal detail, and sentences are no longer cut after “e.g.”, “et al.” or an initial. A word's verdict now comes from its rate compared at equal lengths rather than from shares. The collector removes quotes and code from casual and careful writing. It also joins the line breaks in RAID's human abstracts, which are wrapped at 79 characters; left in, those breaks hid phrases from their patterns on the human side only. In the abstracts, the rates of “delve”, “moreover”, “leverage”, “crucial” and “furthermore” barely moved: the largest change is in the second decimal (GPT-4's “crucial” went from 0.73 to 0.74 per thousand, Llama's “leverage” from 1.50 to 1.49).

[An X thread](https://x.com/barbarosdev/status/2100251154055676256) written from the first version quoted two of the wrong numbers: that the people used no em dash in the abstracts (post 4), and that 89% of the human abstracts and 85% of GPT-4's had no contractions (post 6). Both are wrong, for the reasons in points 2 and 3. What it said about “delve”, “moreover” and “leverage” still holds.

### A correction worth stating plainly

An earlier version of this README, built when the only machine arm was HC3, reported “it is important to note” as the hedging formula that defined GPT-3.5. With RAID's GPT-3.5 arm answering the same documents, that phrase runs at **0.00 per thousand**, while HC3, which is GPT-3.5 *answering questions*, runs at **0.65** (481 times in 3,967 answers). So it is a habit of the assistant-answering-a-question task, not of the model. Matching the documents is what made the difference visible, and the earlier claim was wrong.

## A Claude arm, generated here

No public corpus contains Claude: it is not open-weight, so the benchmarks that get built from open
models pass it by. The gap is in the data rather than in the model, so this arm was generated for
this project — and that makes it different from every other arm in the table, in ways worth stating
before the numbers.

**What was done.** RAID publishes the prompt it gave each model. The prompts for the first fifty
documents of the RAID sample were handed to Claude (Claude Opus 5) verbatim, one call per document,
with one instruction added because the pipeline needs a bare string back: *“Return only the abstract
text itself.”* No style instruction and no examples were added. That gave fifty texts, and forty-five
are measured. Every returned text is in
[`data/generated/claude-abstracts.json`](data/generated/claude-abstracts.json) with its prompt,
including the five that were left out.

**Four things that make this arm weaker than the others, in order of how much they matter.**

1. **The model was asked to write abstracts of real papers, and sometimes it remembered them.**
   Five of the fifty texts reproduce the published abstract: more than half of their five-word
   sequences are in it. Those are human writing wearing a machine label, and they are excluded from
   the measurement. The check is [`scripts/contamination.ts`](scripts/contamination.ts). It runs
   against every arm written from RAID's documents, not only this one, and the weekly run fails if it disagrees with the
   flags in the committed file. None of RAID's 6,000 model texts crosses that line, and five of
   Claude's fifty do. That difference is probably about training cutoffs — these papers are older to
   a 2026 model than they were to a 2023 one — and it is a warning for anyone building a corpus this
   way today.
2. **The generator and the author of this repository are the same system.** The text was produced by
   Claude, and Claude wrote the code that measures it. The prompt is RAID's own and no output was
   picked by hand; the only texts left out are the five the overlap check removed. Still, a model
   asked to write while knowing its style will be measured is not in the same position as one simply
   doing the task.
3. **It was reached through Claude Code, not a bare API call**, so a system prompt was in context.
   What is measured is a model inside a product, which is how most people meet one, but it is not
   the same thing as the model alone.
4. **45 texts against 1,500 in the other arms**, all of them academic abstracts, and 37 of them
   about segmentation. The intervals are correspondingly wide. Its abstracts are also long (a median of
   250 words, against 175 for the person's abstracts overall), so only 20 of them share a length bin with the person's
   abstract of the same document, and its whole-text shares rest on those 20 pairs.

**What the numbers say.** Every RAID writer, counted on the same 45 documents
([`data/claude-matched.json`](data/claude-matched.json)), per thousand words, with the number of
occurrences in brackets:

| marker | human | GPT-3.5 | GPT-4 | Llama chat | Mistral chat | **Claude** |
|---|---|---|---|---|---|---|
| words counted | 9,095 | 5,924 | 4,965 | 12,919 | 5,891 | **11,321** |
| “delve” | 0.00 (0) | 0.00 (0) | 0.00 (0) | 0.00 (0) | 0.00 (0) | **0.00 (0)** |
| “leverage” as a verb | 0.55 (5) | 4.05 (24) | 4.63 (23) | 2.63 (34) | 2.38 (14) | **0.18 (2)** |
| “crucial” | 0.99 (9) | 1.35 (8) | 0.81 (4) | 0.70 (9) | 1.19 (7) | **0.18 (2)** |
| “furthermore” | 0.22 (2) | 0.84 (5) | 1.01 (5) | 0.31 (4) | 0.17 (1) | **0.09 (1)** |
| “moreover” | 0.55 (5) | 0.00 (0) | 0.00 (0) | 0.00 (0) | 0.00 (0) | **0.35 (4)** |
| “in conclusion” / “in summary” / “to sum (it) up” | 0.00 (0) | 0.00 (0) | 0.00 (0) | 0.46 (6) | 0.00 (0) | **0.00 (0)** |
| a three-item list | 1.76 (16) | 1.69 (10) | 4.83 (24) | 5.57 (72) | 2.72 (16) | **5.65 (64)** |
| **a dash, however it is typed** | 0.11 (1) | 0.00 (0) | 0.00 (0) | 0.00 (0) | 0.00 (0) | **0.71 (8)** |

On the vocabulary everybody calls an AI tell, this arm sits at or below the person's abstracts of
the same documents. It uses “leverage” twice (0.18), where the person uses it 5 times (0.55) and the
four RAID models 2.38 to 4.63 per thousand. It uses “crucial” twice too, against the person's 9. It
writes “moreover” 4 times, where the person writes it 5 times and none of the RAID models do. None of
the six writers used “delve” on these documents, GPT-4 included.

Where it stands out is shape. Its three-item lists run at 5.65 per thousand (64 of them, in 37 of its
45 texts), level with GPT-4 (4.83) and Llama (5.57) and well above the person (1.76).

It also wrote 8 dashes, in 4 of its 45 texts. Six of them are the “—” character, and those six are
the only “—” anywhere in the abstracts: none of RAID's 7,500 human and model abstracts contains one.
The person's 45 abstracts hold a single dash, and the RAID models' abstracts none. Eight dashes in four
texts is not much to stand on, and Claude's interval (0.19–1.81 per thousand) overlaps the person's
rate across all 1,500 abstracts (0.24–0.41). If the dash is anybody's habit among these writers, it
belongs to the people and possibly to Claude, not to the four models RAID measured.

## Shares, for the markers you cannot count

Some markers are properties of a whole text — “every sentence the same length”, “no contractions anywhere” — and a rate per thousand words means nothing for them. Those are reported as the share of texts that carry it, with each arm paired against the human reference (the kind and n of each pairing are in [`data/markers.json`](data/markers.json)).

Each cell is that arm's share on its own pairing. The RAID models are paired document by document, and a pair is kept only when both texts fall in the same length bin: 501 pairs for GPT-3.5 and 252 for GPT-4. Casual and careful writing share no documents with the reference, so they are matched to the human abstracts by length from a seeded shuffle (1,480 and 1,500 pairs). The human column is all 1,500 abstracts, and the column after GPT-4 is the person's abstracts of GPT-4's 252 documents, which is what the verdict compares. “Every sentence the same length” only judges texts of five sentences or more, so for that row the human column is the 1,389 abstracts with five or more sentences, and the pairs are fewer: 428 for GPT-3.5, 175 for GPT-4, and 1,376 and 1,389 for casual and careful writing.

| marker | casual writing | careful writing | human (RAID) | GPT-3.5 | **GPT-4** | the person, same documents as GPT-4 | verdict |
|---|---|---|---|---|---|---|---|
| every sentence the same length | 20.9% | 22.2% | 72.6% | 98.8% | **99.4%** | 70.9% | machine marker |
| no first person\* | 19.2% | 33.2% | 99.3% | 100.0% | **100.0%** | 98.8% | register marker |
| no contractions\* | 10.5% | 29.9% | 99.6% | 100.0% | **100.0%** | 99.6% | register marker |
| no personal detail\* | 96.0% | 98.6% | 100.0% | 100.0% | **100.0%** | 100.0% | register marker |
| no informal spelling\* | 92.7% | 98.3% | 100.0% | 100.0% | **100.0%** | 100.0% | register marker |

\* a marker people are documented to judge by rather than one anybody measured ([Jakesch et al., PNAS 2023](https://www.pnas.org/doi/10.1073/pnas.2208839120)).

The three-item list used to sit in this table. It can be counted, so it now has a rate in the first table, and its verdict comes from that rate.

**Contractions and first person are register markers, not machine markers.** An abstract has neither, whoever writes it: 99.6% of the human abstracts have no contraction and 99.3% no “I”, “my” or “me”, and GPT-4's have none of either. Casual writing is the opposite: only 10.5% of the casual texts matched to the abstracts' lengths go without a contraction, and 19.2% without first person. Careful writing sits in between (29.9% and 33.2%), and so does GPT-3.5 answering questions (52.5% and 87.2%). Judging by contractions or by “I” is judging what kind of text you are reading. Personal detail and informal spelling say even less, because they are rare in every kind of writing measured here.

**Even sentence lengths are the whole-text marker that holds**: 99.4% of GPT-4's abstracts have every sentence about the same length, against 70.9% of the person's abstracts of the same documents and 20.9% of casual texts. Abstracts are even to begin with, so the gap is between GPT-4 and a genre that already leans that way.

## The arms

| arm | what it is | texts |
|---|---|---|
| casual writing | everyday online comments posted before **2022-11-30**, the day ChatGPT opened (source: Hacker News) | 4,000 |
| careful writing | edited question-and-answer posts from the same period (source: Stack Exchange: english, academia, writing) | 3,863 |
| human (RAID) | the human documents every model was asked to continue | 1,500 |
| GPT-3.5, GPT-4, Llama chat, Mistral chat | [RAID](https://github.com/liamdugan/raid) continuations of those same documents, unattacked rows only | 1,500 each |
| Claude (generated here) | Claude Opus 5 through Claude Code, given RAID's prompts for the first fifty documents; the five that reproduce the published abstract are left out ([its own section](#a-claude-arm-generated-here)) | 45 |
| HC3 | GPT-3.5 answering questions — a different task, kept as the contrast that produced [the hedging correction](#a-correction-worth-stating-plainly) | 3,967 |

RAID's adversarial rows — homoglyphs, inserted whitespace, deliberate misspellings — are excluded; measuring style markers there would measure the attack.

## How the counting is done

1. **Two measures, each for the kind of marker it suits, and each decides its own verdict.** A word or phrase becomes occurrences per thousand words over every text in the arm. That rate still depends on length: a phrase used once in a text has half the rate in a text twice as long, and GPT-4 wrote its abstracts nearly 40% shorter than the people did (a median of 109 words against 175). So the table shows the whole-arm rates, but the verdict compares GPT-4 with the person only between texts within a tenth of each other in length. A property of the whole text cannot be counted that way, so it is a share, and for a share length is controlled by the pairing.
2. **Length is controlled pairwise, and the pairs are not the file's order.** Matching eight arms at once cuts every arm down to the smallest one in every bin; the first attempt at this collapsed a 1,499-text arm to 123. Each arm is matched against the human reference on its own instead. A model's text, from RAID or from the Claude arm, is paired with the human text for the same document, and the pair is kept only when both fall in the same length bin. Casual writing, careful writing and HC3 share no documents with the reference, so each of their bins is filled from a seeded shuffle. The corpora are stored grouped by topic, and an earlier version that took the first texts of every bin was comparing one topic with another. Every pairing publishes its kind and its n.
3. **A text a marker cannot judge is left out, not counted as a no.** “Every sentence the same length” says nothing about a text with fewer than five sentences, so such a text is dropped from that marker's shares on both sides of a pairing.
4. **The writer's own words.** Block quotes, quoted lines and code are removed from the casual and careful writing before anything is counted, and a span in double quotes does not count towards three of the belief markers (contractions, first person, personal detail). RAID's human abstracts come wrapped at 79 columns and the models' texts do not, so those line breaks are joined before counting; left in, they hid a phrase from its pattern on the human side only.
5. **A placebo arm.** The reference corpus is split at random and the same tests run on both halves. Every number there should be a tie; all 25 are. An earlier version split by position, which meant splitting by date, and the placebo disagreed until the split was randomised.
6. **Intervals, and a correction.** Wilson intervals for shares. Exact Poisson intervals for rates, and an exact test between them, both widened when writers repeat a word within one text, because those occurrences are not independent. Benjamini–Hochberg across the catalogue, and a word's verdict needs its rate test to survive it.

## Run it

```bash
git clone https://github.com/barbarkaragul-oss/is-it-really-an-ai-tell && cd is-it-really-an-ai-tell
npm install
npx tsx collector/fetch.ts --want 4000        # Hacker News, Stack Exchange, HC3
npx tsx collector/fetch-raid.ts --want 1500   # research abstracts: one document, five writers
npx tsx collector/fetch-raid.ts --genre posts # Reddit posts: two byte windows of RAID's CSV
G="--genres abstracts,posts --data /tmp/aitell-data"   # a local run writes to scratch; only the weekly job writes data/
npx tsx scripts/contamination.ts $G           # drops cut-off, not-an-answer and remembered model texts, and revised abstracts
npx tsx scripts/measure-all.ts $G             # per kind of writing: genres/<kind>/markers.json, and summary.json
npx tsx scripts/evidence.ts $G                # what each pattern matched: genres/<kind>/evidence.json
npx tsx scripts/claude-matched.ts --data /tmp/aitell-data   # every writer on the documents Claude covered
npx tsx scripts/build.ts --data /tmp/aitell-data --docs /tmp/aitell-docs   # the site
npm test
```

The abstracts are dated once, by hand, with `npx tsx scripts/arxiv-dates.ts` (about two hours at arXiv's pace of one request every three seconds, cached and resumable), which writes `data/abstracts-dates.json`. Run it after `fetch-raid.ts --want 1500`, so it dates the same documents the weekly job measures. A document it fails on every time can be recorded as not dated with `--skip <source_id>`. The weekly job builds with `--release`, which refuses to publish abstracts measured without a complete dating.

**The corpus text is not committed, deliberately.** Hacker News licenses its content to Y Combinator, Stack Exchange answers are CC BY-SA, and the Reddit posts are their authors' under Reddit's and Pushshift's terms. What ships is ids and counts; the fetch scripts rebuild the exact corpus. The Reddit posts and their titles stay in `out/` and `cache/`, which are never committed, and a model's sentence that repeats a post's title or runs of its words is not quoted either. RAID is 2.3 GB across ten parquet shards and none of it is downloaded whole: row-group statistics say which groups can hold the wanted rows, and only those are fetched over HTTP range requests, paced so the host does not have to refuse.

## Limits

- **Five models, and one of them is this repository's own.** Four come from a published benchmark; the Claude arm was generated here, is 45 texts against 1,500, and carries the caveats in its own section. No Gemini at all.
- **Two kinds of writing for the matched set, one source for each comparison.** The matched documents are research abstracts and Reddit posts, each measured on its own; casual and careful writing are there to show how much of a marker is really about the kind of text, but they are not matched by document and each comes from a single site. Email, chat, product reviews, student essays and social platforms other than Reddit are not in yet. The Reddit file RAID used is not filtered for bots or spam, and the people's posts are counted, never quoted.
- **Markers are regexes.** “Delve” catches the word and not the idea, and irony is invisible to all of it.
- **Presence and rate disagree sometimes.** For a word, the verdict follows the rate compared at equal lengths; a whole-arm rate can still lean on GPT-4's shorter texts, and a word that only the short texts use has little to be compared with.
- **English only.** A document is left out of every column when any of its writers, the person included, wrote it in another language: a few dozen Reddit posts are in Turkish, Russian, Spanish and others, and the models answered some English titles in other languages too.
- **This cannot tell you who wrote a text**, and no number of markers will make it able to.

## License

MIT. The corpora keep their own licences. RAID's model generations are MIT; the human texts inside RAID keep their sources' terms: the arXiv abstracts are CC0 and are quoted, the Reddit posts are counted and referenced by RAID id only. HC3 is CC BY-SA 4.0 and referenced by id; Hacker News and Stack Exchange content stays with its owners and is linked, not quoted.
