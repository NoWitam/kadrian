import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export function repoPath(...segments: string[]): string {
  return join(repoRoot, ...segments);
}

export function readText(...segments: string[]): string {
  return readFileSync(repoPath(...segments), 'utf8');
}

/** Callers assert the shape they expect; these files are part of the repository. */
export function readJson(...segments: string[]): unknown {
  return JSON.parse(readText(...segments));
}

/** Collapses whitespace so that re-wrapped prose and CRLF checkouts compare equal. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function listDirs(...segments: string[]): string[] {
  return readdirSync(repoPath(...segments), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Files below a directory, as repository-relative paths with forward slashes. */
export function listFiles(...segments: string[]): string[] {
  return readdirSync(repoPath(...segments), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(repoRoot, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort();
}

export const packageDirs = listDirs('packages');

/** `AGENTS.md` is the binding source that ADRs and package manifests are checked against. */
export const agentsText = normalizeWhitespace(readText('AGENTS.md'));
