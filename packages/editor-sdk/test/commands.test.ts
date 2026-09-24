/**
 * `parseCommand` is the single normalisation point (D30.3): it decides what a
 * command is, rounds the coordinates to integer composition pixels (D15), and
 * freezes the result. Everything that enters the bus passes through it, which
 * is what keeps the UI and the AI tool of PR-09 from diverging (P4).
 */
import { describe, expect, it } from 'vitest';

import { COMMAND_TYPES, parseCommand, type Command } from '../src/index.js';

import { codeOf, errorOf } from './support.js';

const wellFormed = { type: 'SetNodePosition', nodeId: 'node-title', position: { x: 12, y: 34 } };

describe('parseCommand (D30.3)', () => {
  it('knows exactly the one command of the spike (§9)', () => {
    expect(COMMAND_TYPES).toEqual(['SetNodePosition']);
  });

  it('accepts a well-formed command and returns it unchanged', () => {
    expect(parseCommand(wellFormed)).toEqual(wellFormed);
  });

  it('freezes the command and its position, so a kept reference cannot reach the history', () => {
    const command = parseCommand(wellFormed);
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.position)).toBe(true);
  });

  it('is idempotent', () => {
    const once = parseCommand(wellFormed);
    const twice = parseCommand(once);
    expect(twice).toEqual(once);
    expect(parseCommand(twice)).toEqual(once);
  });

  it.each([
    ['rounds down', 90.4, 90],
    ['rounds up', 90.6, 91],
    ['rounds a positive half towards +Infinity', 90.5, 91],
    ['rounds a negative half towards +Infinity', -2.5, -2],
    ['rounds the other negative half away from zero', -2.6, -3],
    ['keeps an integer', -1_000_000, -1_000_000],
  ])('%s: %d becomes %d', (_, given, expected) => {
    expect(parseCommand({ ...wellFormed, position: { x: given, y: 0 } }).position.x).toBe(expected);
  });

  it('normalises -0 to 0, which -0 does not survive as under Object.is', () => {
    const { position } = parseCommand({ ...wellFormed, position: { x: -0, y: -0.4 } });
    expect(Object.is(position.x, 0)).toBe(true);
    expect(Object.is(position.y, 0)).toBe(true);
  });

  it.each([
    ['null', null, 'invalid-argument'],
    ['an array', [], 'invalid-argument'],
    ['a string', 'SetNodePosition', 'invalid-argument'],
    ['a number', 1, 'invalid-argument'],
    ['no type', { nodeId: 'node-title', position: { x: 1, y: 2 } }, 'invalid-argument'],
    ['a non-string type', { ...wellFormed, type: 7 }, 'invalid-argument'],
    ['an unknown type', { ...wellFormed, type: 'MoveNode' }, 'unknown-command'],
    [
      'a relative command',
      { type: 'MoveNode', nodeId: 'node-title', dx: 1, dy: 2 },
      'unknown-command',
    ],
    ['an unknown field', { ...wellFormed, z: 1 }, 'invalid-argument'],
    ['no nodeId', { type: 'SetNodePosition', position: { x: 1, y: 2 } }, 'invalid-argument'],
    ['an empty nodeId', { ...wellFormed, nodeId: '' }, 'invalid-argument'],
    ['a non-string nodeId', { ...wellFormed, nodeId: 7 }, 'invalid-argument'],
    ['no position', { type: 'SetNodePosition', nodeId: 'node-title' }, 'invalid-argument'],
    ['a position that is not an object', { ...wellFormed, position: 7 }, 'invalid-argument'],
    ['a position that is an array', { ...wellFormed, position: [1, 2] }, 'invalid-argument'],
    [
      'a position with a third axis',
      { ...wellFormed, position: { x: 1, y: 2, z: 3 } },
      'invalid-argument',
    ],
    ['a position without y', { ...wellFormed, position: { x: 1 } }, 'invalid-argument'],
    ['NaN', { ...wellFormed, position: { x: Number.NaN, y: 0 } }, 'invalid-argument'],
    [
      'Infinity',
      { ...wellFormed, position: { x: Number.POSITIVE_INFINITY, y: 0 } },
      'invalid-argument',
    ],
    [
      '-Infinity',
      { ...wellFormed, position: { x: 0, y: Number.NEGATIVE_INFINITY } },
      'invalid-argument',
    ],
    ['a numeric string', { ...wellFormed, position: { x: '12', y: 0 } }, 'invalid-argument'],
    ['a null coordinate', { ...wellFormed, position: { x: null, y: 0 } }, 'invalid-argument'],
  ])('rejects %s with %s', (_, payload, code) => {
    expect(codeOf(() => parseCommand(payload))).toBe(code);
  });

  it('names the offending field and the value it refused', () => {
    expect(
      errorOf(() => parseCommand({ ...wellFormed, position: { x: Number.NaN, y: 0 } })).message,
    ).toBe('`position`.x must be a finite number, not NaN.');
    expect(errorOf(() => parseCommand({ ...wellFormed, z: 1 })).message).toContain(
      'must have exactly the fields nodeId, position, type',
    );
  });

  it('accepts a typed literal, which is what the UI and the AI tool both write', () => {
    const command: Command = {
      type: 'SetNodePosition',
      nodeId: 'node-title',
      position: { x: 1, y: 2 },
    };
    expect(parseCommand(command)).toEqual(command);
  });
});
