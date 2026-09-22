/**
 * The Player validates documents under a Content Security Policy without
 * `unsafe-eval` (D17). V8's `--disallow-code-generation-from-strings` makes
 * `eval` and `new Function` throw exactly as such a policy does, so a child
 * process with that flag stands in for the browser. It loads the built output,
 * which is what a consumer gets (D11).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

function runWithoutCodeGeneration(script: string): { status: number | null; output: string } {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    ['--disallow-code-generation-from-strings', '--input-type=module', '--eval', script],
    { cwd: packageRoot, encoding: 'utf8' },
  );
  return { status, output: `${stdout}${stderr}` };
}

describe('validation without code generation', () => {
  it('control: the flag really blocks new Function', () => {
    const { status, output } = runWithoutCodeGeneration("new Function('return 1')();");
    expect(status).not.toBe(0);
    expect(output).toContain('EvalError');
  });

  it('validates the reference composition and reports a typed error', () => {
    const { status, output } = runWithoutCodeGeneration(`
      import { validateComposition } from '@kadrion/schema';
      import { referenceComposition } from '@kadrion/test-fixtures';
      const valid = validateComposition(referenceComposition);
      const invalid = validateComposition({ ...referenceComposition, unknownField: 1 });
      console.log(JSON.stringify({ valid: valid.ok, invalid: invalid.ok ? [] : invalid.errors }));
    `);
    expect(status, output).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      valid: true,
      invalid: [{ code: 'unknown-field', path: '/unknownField' }],
    });
  });
});
