import type { FixturePatchOperation } from '@kadrion/test-fixtures';

function tokensOf(path: string): string[] {
  if (!path.startsWith('/')) throw new Error(`Unsupported JSON Pointer "${path}".`);
  return path
    .slice(1)
    .split('/')
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function indexOf(items: readonly unknown[], token: string, path: string): number {
  const index = Number(token);
  if (!Number.isInteger(index) || index < 0 || index >= items.length) {
    throw new Error(`"${path}" does not exist.`);
  }
  return index;
}

function applyOperation(document: unknown, { op, path, value }: FixturePatchOperation): void {
  const tokens = tokensOf(path);
  const last = tokens.pop() ?? '';
  let parent = document;
  for (const token of tokens) {
    if (Array.isArray(parent)) {
      const items: unknown[] = parent;
      parent = items[indexOf(items, token, path)];
    } else if (typeof parent === 'object' && parent !== null && Object.hasOwn(parent, token)) {
      parent = (parent as Record<string, unknown>)[token];
    } else {
      throw new Error(`"${path}" does not exist.`);
    }
  }

  if (Array.isArray(parent)) {
    const items: unknown[] = parent;
    if (op === 'add' && last === '-') items.push(value);
    else if (op === 'add')
      throw new Error(`Only "-" is supported for adding to an array: "${path}".`);
    else if (op === 'replace') items[indexOf(items, last, path)] = value;
    else items.splice(indexOf(items, last, path), 1);
  } else if (typeof parent === 'object' && parent !== null) {
    const fields = parent as Record<string, unknown>;
    const exists = Object.hasOwn(fields, last);
    if (op === 'add' && exists) throw new Error(`"${path}" already exists.`);
    if (op !== 'add' && !exists) throw new Error(`"${path}" does not exist.`);
    if (op === 'remove') Reflect.deleteProperty(fields, last);
    else fields[last] = value;
  } else {
    throw new Error(`"${path}" does not exist.`);
  }
}

/**
 * Applies an RFC 6902 subset to a deep copy. Strict on purpose: a patch that
 * no longer matches the reference composition fails instead of silently doing
 * nothing, so a negative fixture cannot rot into a no-op.
 */
export function applyPatch(document: unknown, patch: readonly FixturePatchOperation[]): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(document));
  for (const operation of patch) applyOperation(copy, operation);
  return copy;
}
