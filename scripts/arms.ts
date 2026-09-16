/**
 * The arms, in one place, so the measurement and the evidence read the same corpora.
 *
 * Machine arms are read from the -clean files scripts/contamination.ts writes, never from the raw
 * download, so a text that reproduces the human document cannot reach the table.
 *
 * `publishable` says whether an arm's own text may be quoted in this repository. RAID is MIT and the
 * Claude arm was generated here; Hacker News content is licensed to Y Combinator and Stack Exchange
 * answers are CC BY-SA, so those arms are referenced by link only, and HC3 by id.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Arm, Text } from '../src/measure.js';

export const OUT = path.resolve('out');

export interface ArmSpec { id: string; label: string; kind: 'human' | 'machine'; file: string; publishable: boolean }

export const ARMS: ArmSpec[] = [
  { id: 'casual-human', label: 'casual writing: online comments from before ChatGPT (Hacker News)', kind: 'human', file: 'casual-human', publishable: false },
  { id: 'careful-human', label: 'careful writing: edited Q&A answers from the same period (Stack Exchange)', kind: 'human', file: 'careful-human', publishable: false },
  { id: 'raid-human', label: 'human (RAID: the documents every model continued)', kind: 'human', file: 'raid-human', publishable: true },
  { id: 'raid-chatgpt', label: 'GPT-3.5 (same documents)', kind: 'machine', file: 'raid-chatgpt-clean', publishable: true },
  { id: 'raid-gpt4', label: 'GPT-4 (same documents)', kind: 'machine', file: 'raid-gpt4-clean', publishable: true },
  { id: 'raid-llama-chat', label: 'Llama chat (same documents)', kind: 'machine', file: 'raid-llama-chat-clean', publishable: true },
  { id: 'raid-mistral-chat', label: 'Mistral chat (same documents)', kind: 'machine', file: 'raid-mistral-chat-clean', publishable: true },
  // generated for this project rather than taken from a published corpus; see the README
  { id: 'raid-claude', label: 'Claude Opus 5 via Claude Code (same documents, generated here)', kind: 'machine', file: 'raid-claude-clean', publishable: true },
  { id: 'hc3-gpt35', label: 'GPT-3.5 answering questions (HC3, a different genre)', kind: 'machine', file: 'machine-2023', publishable: false },
];

export function loadArm(spec: ArmSpec): Arm | null {
  const f = path.join(OUT, `${spec.file}.json`);
  if (!existsSync(f)) {
    // a machine arm that was fetched but never checked must not quietly drop out of the table
    if (spec.file.endsWith('-clean') && existsSync(path.join(OUT, `${spec.file.replace(/-clean$/, '')}.json`))) {
      throw new Error(`out/${spec.file}.json is missing; run scripts/contamination.ts first`);
    }
    return null;
  }
  const rows = JSON.parse(readFileSync(f, 'utf8')) as { id: string; text: string }[];
  const texts: Text[] = rows.map((r) => ({ id: String(r.id), text: r.text, source: spec.file }));
  return texts.length ? { id: spec.id, label: spec.label, kind: spec.kind, texts } : null;
}

export function loadArms(): { arm: Arm; spec: ArmSpec }[] {
  return ARMS.flatMap((spec) => {
    const arm = loadArm(spec);
    return arm ? [{ arm, spec }] : [];
  });
}
