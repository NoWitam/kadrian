import { readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { agentsText, normalizeWhitespace, readText, repoPath } from './repo.js';

const ADR_FILE = /^D\d{2}-[a-z0-9-]+\.md$/;
const STATUS = /^- Status: (Proposed|Accepted|Rejected|Deprecated|Superseded by D\d{2})\b/m;

const files = readdirSync(repoPath('docs', 'adr'))
  .filter((file) => ADR_FILE.test(file))
  .sort();
const index = readText('docs', 'adr', 'README.md');
const idOf = (file: string): string => file.slice(0, 3);

/** Decisions exactly as `AGENTS.md` states them, keyed by identifier. */
const accepted = new Map(
  [...agentsText.matchAll(/- (D\d{2}): (.*?)(?= - D\d{2}: | Treat these decisions)/g)].map(
    (match) => [match[1] ?? '', match[2] ?? ''],
  ),
);

/** Returns the blockquotes of one `## <heading>` section, each collapsed to a single line. */
function quotesIn(markdown: string, heading: string): string[] {
  const section = markdown.split(/^## /m).find((part) => part.startsWith(heading)) ?? '';
  return section
    .split(/\n\s*\n/)
    .filter((block) => block.trimStart().startsWith('>'))
    .map((block) => normalizeWhitespace(block.replace(/^\s*>\s?/gm, '')));
}

describe('ADR log', () => {
  it('uses every identifier once', () => {
    const ids = files.map(idOf);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('records every decision that AGENTS.md lists as accepted', () => {
    expect(accepted.size).toBe(10);
    expect(files.map(idOf)).toEqual(expect.arrayContaining([...accepted.keys()]));
  });
});

describe.each(files)('%s', (file) => {
  const id = idOf(file);
  const text = readText('docs', 'adr', file);
  const status = STATUS.exec(text)?.[1];

  it('has a matching title and a known status', () => {
    expect(text.startsWith(`# ${id} — `)).toBe(true);
    expect(status).toBeDefined();
  });

  it('is listed in the index with the same status', () => {
    const row = index.split('\n').find((line) => line.includes(`](${file})`));
    expect(row).toContain(`| ${status ?? 'unknown'}`);
  });
});

describe.each(files.filter((file) => accepted.has(idOf(file))))('%s (from AGENTS.md)', (file) => {
  const id = idOf(file);
  const text = readText('docs', 'adr', file);

  it('stays Accepted', () => {
    expect(STATUS.exec(text)?.[1]).toBe('Accepted');
  });

  it('quotes its decision verbatim', () => {
    expect(quotesIn(text, 'Decision')).toEqual([`${id}: ${accepted.get(id) ?? ''}`]);
  });

  it('quotes related rules verbatim', () => {
    const rules = quotesIn(text, 'Related rules');
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(agentsText).toContain(rule);
  });
});
