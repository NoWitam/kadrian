/**
 * What the Producer decides before a browser exists (D26, D28): the pins and the
 * pinned detection, the host document and the agent, the runtime identity, the
 * grid times, the canonical composition hash, and the typed errors raised
 * before the page opens. Everything that needs Chromium is in `tests/pinned`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  RENDER_PAGE_FRAME_STYLE,
  RENDER_PAGE_SANDBOX,
  renderPageDocument,
} from '@kadrion/renderer-dom';
import {
  generateReferenceAssets,
  goldenTimestamps,
  referenceComposition,
} from '@kadrion/test-fixtures';
import { describe, expect, it } from 'vitest';

import {
  CHROMIUM_ARGS,
  CHROMIUM_REVISION,
  CHROMIUM_VERSION,
  PINNED_IMAGE,
  PLAYWRIGHT_CORE_VERSION,
  PRODUCER_AGENT_SCRIPT,
  canonicalJson,
  contextOptions,
  environmentManifest,
  frameIndexOf,
  hostDocument,
  installedPlaywright,
  goldenRefusal,
  isPinned,
  networkFacts,
  loadRuntimeBuild,
  renderFrames,
  verifiedScript,
} from '../src/index.js';
import { hostNetworkInterfaces } from '../src/environment.js';
import { producerCode } from '../src/errors.js';
import { validateComposition, type ValidatedComposition } from '@kadrion/schema';

const buildDirectory = new URL('../../renderer-dom/dist/runtime-build/', import.meta.url);
const artifact = readFileSync(fileURLToPath(new URL('kadrion-runtime.js', buildDirectory)));
const runtimeManifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('kadrion-runtime.json', buildDirectory)), 'utf8'),
) as { contentHash: string };

function validated(input: unknown): ValidatedComposition {
  const result = validateComposition(input);
  if (!result.ok) throw new Error('invalid');
  return result.composition;
}
const reference = validated(referenceComposition);
const assets = Object.fromEntries(generateReferenceAssets().map((asset) => [asset.id, asset]));

describe('the pins of D26', () => {
  it('match what the installed playwright-core pins', () => {
    expect(installedPlaywright()).toEqual({
      version: PLAYWRIGHT_CORE_VERSION,
      revision: CHROMIUM_REVISION,
      browserVersion: CHROMIUM_VERSION,
    });
    expect([PLAYWRIGHT_CORE_VERSION, CHROMIUM_REVISION, CHROMIUM_VERSION]).toEqual([
      '1.63.0',
      '1243',
      '153.0.8010.12',
    ]);
    expect(PINNED_IMAGE).toBe(
      'mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27',
    );
  });

  it('open every page at the composition size, scale 1, en-US, UTC', () => {
    expect(contextOptions(1080, 1920)).toEqual({
      viewport: { width: 1080, height: 1920 },
      deviceScaleFactor: 1,
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'light',
      reducedMotion: 'no-preference',
    });
    expect(CHROMIUM_ARGS).toEqual([
      '--force-color-profile=srgb',
      '--disable-lcd-text',
      '--hide-scrollbars',
      '--mute-audio',
    ]);
  });

  const pinned = {
    image: PINNED_IMAGE,
    platform: 'linux',
    arch: 'x64',
    reportedVersion: CHROMIUM_VERSION,
  };

  it('call only the container on linux/x64 with the expected browser pinned (D26.2)', () => {
    expect(isPinned(pinned)).toBe(true);
    for (const [key, value] of Object.entries({
      image: `${PINNED_IMAGE.slice(0, -1)}0`,
      platform: 'win32',
      arch: 'arm64',
      reportedVersion: '153.0.8010.13',
    })) {
      expect(isPinned({ ...pinned, [key]: value }), key).toBe(false);
    }
    expect(isPinned({ ...pinned, image: undefined })).toBe(false);
  });

  it('record the environment manifest of D26.4', () => {
    // The network is injected: a unit test never reads the host's interfaces.
    const facts = { ...pinned, networkInterfaces: ['lo'] };
    const manifest = environmentManifest(CHROMIUM_VERSION, { width: 1080, height: 1920 }, facts);
    expect(manifest).toMatchObject({
      pinned: true,
      image: PINNED_IMAGE,
      pinnedPlatform: 'linux/amd64',
      os: 'linux',
      arch: 'x64',
      playwrightCore: '1.63.0',
      chromiumRevision: '1243',
      chromiumVersion: CHROMIUM_VERSION,
      reportedVersion: CHROMIUM_VERSION,
      channel: 'chromium',
      locale: 'en-US',
      timezone: 'UTC',
      viewport: { width: 1080, height: 1920 },
      deviceScaleFactor: 1,
    });
    expect(environmentManifest(CHROMIUM_VERSION, { width: 1, height: 1 }, facts).node).toBe(
      process.version,
    );
    expect(environmentManifest('1.0', { width: 1, height: 1 }, facts).pinned).toBe(false);
  });

  it('read the host interfaces through one reader that never assumes a network (D28.9)', () => {
    expect(hostNetworkInterfaces(() => ({ lo: [], eth0: [] }))).toEqual(['lo', 'eth0']);
    expect(hostNetworkInterfaces(() => ({}))).toEqual([]);
    // A host that refuses the call is an error, not an isolated run.
    expect(() =>
      hostNetworkInterfaces(() => {
        throw new Error('uv_interface_addresses returned Unknown system error');
      }),
    ).toThrow('uv_interface_addresses');
  });

  it('let golden frames be written in the pinned environment without a network only (D26.5, D28.9)', () => {
    const isolated = environmentManifest(
      CHROMIUM_VERSION,
      { width: 1, height: 1 },
      {
        ...pinned,
        networkInterfaces: ['lo'],
      },
    );
    expect(goldenRefusal(isolated)).toBeNull();
    const networked = environmentManifest(
      CHROMIUM_VERSION,
      { width: 1, height: 1 },
      {
        ...pinned,
        networkInterfaces: ['lo', 'eth0'],
      },
    );
    expect(goldenRefusal(networked)).toContain('the run has a network (eth0, lo)');
    const elsewhere = environmentManifest(
      CHROMIUM_VERSION,
      { width: 1, height: 1 },
      {
        ...pinned,
        platform: 'win32',
        networkInterfaces: ['lo'],
      },
    );
    expect(goldenRefusal(elsewhere)).toContain('not the pinned environment');
  });

  it('record the network of the run by interface names only, and loopbackOnly for lo alone (D28.9)', () => {
    expect(networkFacts(['lo'])).toEqual({ interfaces: ['lo'], loopbackOnly: true });
    expect(networkFacts(['lo', 'eth0'])).toEqual({
      interfaces: ['eth0', 'lo'],
      loopbackOnly: false,
    });
    expect(networkFacts(['eth0'])).toEqual({ interfaces: ['eth0'], loopbackOnly: false });
    expect(networkFacts([])).toEqual({ interfaces: [], loopbackOnly: false });
    expect(networkFacts(['lo0'])).toEqual({ interfaces: ['lo0'], loopbackOnly: false });
    const manifest = environmentManifest(
      CHROMIUM_VERSION,
      { width: 1, height: 1 },
      {
        ...pinned,
        networkInterfaces: ['lo'],
      },
    );
    expect(manifest.network).toEqual({ interfaces: ['lo'], loopbackOnly: true });
    // Names only: an address or a MAC would end up in a committed golden manifest.
    expect(JSON.stringify(manifest.network)).not.toMatch(/\d+\.\d+\.\d+|[0-9a-f]{2}:[0-9a-f]{2}/);
  });
});

describe('the page of D28.1', () => {
  const html = hostDocument('/* runtime */', 1080, 1920);
  const frames = [...html.matchAll(/<iframe\b[^>]*>/g)];

  it('holds exactly one sandboxed frame, sized and styled like the Player’s', () => {
    expect(frames).toHaveLength(1);
    const tag = frames[0]?.[0] ?? '';
    expect(tag).toContain(`sandbox="${RENDER_PAGE_SANDBOX}"`);
    const style = Object.entries({ ...RENDER_PAGE_FRAME_STYLE, width: '1080px', height: '1920px' })
      .map(([name, value]) => `${name}: ${value}`)
      .join('; ');
    expect(tag).toContain(`style="${style}"`);
    expect(html).toContain('html,body{margin:0;padding:0;overflow:hidden}');
    expect(html).not.toMatch(/\ssrc=|\shref=/);
  });

  it('carries the renderer’s page with the runtime and the agent as its srcdoc, unchanged', () => {
    const srcdoc = /srcdoc="([^"]*)"/.exec(html)?.[1] ?? '';
    const text = srcdoc.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
    expect(text).toBe(renderPageDocument(['/* runtime */', PRODUCER_AGENT_SCRIPT]));
  });

  it('refuses a runtime that would end its script element', () => {
    expect(() => hostDocument('"</script>"', 1, 1)).toThrow(
      expect.objectContaining({ code: 'runtime-unsafe' }),
    );
  });
});

describe('the agent of D28.3', () => {
  it('only calls load and frame of the artifact, with a font constructor and a timer it captured', () => {
    expect(PRODUCER_AGENT_SCRIPT.startsWith('(function producerAgent()')).toBe(true);
    expect(PRODUCER_AGENT_SCRIPT).toContain('.load(root');
    expect(PRODUCER_AGENT_SCRIPT).toContain('.frame(root');
    for (const fragment of [
      'mount(',
      'render(',
      'synchronize(',
      'postMessage',
      'import',
      'require(',
    ]) {
      expect(PRODUCER_AGENT_SCRIPT).not.toContain(fragment);
    }
    const captured = PRODUCER_AGENT_SCRIPT.indexOf('window.setTimeout.bind(window)');
    expect(captured).toBeGreaterThan(-1);
    expect(PRODUCER_AGENT_SCRIPT.indexOf('startTimeout(expire')).toBeGreaterThan(captured);
    expect(PRODUCER_AGENT_SCRIPT).not.toMatch(/[^.]setTimeout\(/);
  });
});

describe('runtime identity (D28.2)', () => {
  it('loads the artifact of @kadrion/renderer-dom with the hash of its manifest', () => {
    const build = loadRuntimeBuild();
    expect(build.contentHash).toBe(runtimeManifest.contentHash);
    expect(build.script).toBe(artifact.toString('utf8'));
  });

  it('refuses other bytes and bytes that are not UTF-8', () => {
    expect(() => verifiedScript(new Uint8Array([1]), runtimeManifest.contentHash)).toThrow(
      expect.objectContaining({ code: 'runtime-hash-mismatch' }),
    );
    const bad = new Uint8Array([0xff, 0xfe]);
    const hash = `sha256:${createHash('sha256').update(bad).digest('hex')}`;
    expect(() => verifiedScript(bad, hash)).toThrow(
      expect.objectContaining({ code: 'runtime-unsafe' }),
    );
  });
});

describe('grid times (D13.2, D28.4)', () => {
  it('maps the golden timestamps to their frames', () => {
    expect(goldenTimestamps.map(({ timeUs }) => frameIndexOf(reference, timeUs))).toEqual(
      goldenTimestamps.map(({ frame }) => frame),
    );
    expect(frameIndexOf(reference, 33_333)).toBe(1);
    expect(frameIndexOf(reference, 9_966_666)).toBe(299);
  });

  it.each([1, 33_334, -1, 10_000_000, 0.5, Number.NaN])('refuses %s', (timeUs) => {
    expect(() => frameIndexOf(reference, timeUs)).toThrow(
      expect.objectContaining({ code: 'frame-out-of-range' }),
    );
  });
});

describe('the composition hash (D28.7)', () => {
  it('is the SHA-256 of JSON with sorted keys, whatever the key order of the input', () => {
    expect(canonicalJson({ b: [2, { d: 1, c: 'x' }], a: null })).toBe(
      '{"a":null,"b":[2,{"c":"x","d":1}]}',
    );
    const reordered = JSON.parse(
      JSON.stringify(referenceComposition, (_, value: unknown) =>
        typeof value === 'object' && value !== null && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse())
          : value,
      ),
    ) as unknown;
    expect(canonicalJson(reordered)).toBe(canonicalJson(referenceComposition));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson('é"\n')).toBe(JSON.stringify('é"\n'));
  });
});

describe('typed errors before the page opens (D28.6)', () => {
  const resolve = ({ id }: { id: string }) => assets[id] ?? null;

  it.each([
    [
      'an invalid document',
      { ...(referenceComposition as object), fps: 0 },
      [0],
      resolve,
      'invalid-document',
    ],
    ['a time off the grid', referenceComposition, [1], resolve, 'frame-out-of-range'],
    ['a missing asset', referenceComposition, [0], () => null, 'asset-missing'],
    [
      'bytes of another hash',
      referenceComposition,
      [0],
      ({ id }: { id: string }) =>
        id === 'asset-font'
          ? { bytes: new Uint8Array([1]), mediaType: 'font/ttf' }
          : resolve({ id }),
      'asset-hash-mismatch',
    ],
    [
      'an asset without a media type',
      referenceComposition,
      [0],
      ({ id }: { id: string }) => ({
        bytes: assets[id]?.bytes ?? new Uint8Array(0),
        mediaType: 'x',
      }),
      'asset-invalid',
    ],
  ])('reports %s without starting a browser', async (_, document, timesUs, resolveAsset, code) => {
    // No `chromium` is passed and none is installed for this test: a launch would fail
    // with chromium-missing or chromium-mismatch, not with the expected code.
    await expect(renderFrames({ document, timesUs, resolveAsset })).rejects.toMatchObject({
      name: 'ProducerError',
      code,
    });
  });

  it('maps the codes of the page and of the renderer, and nothing else', () => {
    for (const code of ['font-load-failed', 'custom-html-timeout', 'asset-url-missing']) {
      expect(producerCode(code)).toBe(code);
    }
    expect(producerCode('state-mismatch')).toBe('page-error');
    expect(producerCode(undefined)).toBe('page-error');
  });
});
