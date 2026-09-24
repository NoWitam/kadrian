/**
 * The isolation of Custom HTML in Chromium (specification §7.6, D23.7, D28),
 * measured from inside the element in the Producer's page, which embeds the
 * render page exactly as the Player does (D28.1). Every outcome is written to
 * `.kadrion-out/custom-html-probes.json`; the tests assert what §7.6 requires
 * and report what D23.7 asks to be measured. Informative outside the pinned
 * environment.
 */
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

import {
  launchChromium,
  networkFacts,
  openRenderSession,
  renderFrames,
  sha256,
  type LaunchedChromium,
  type RenderSession,
} from '@kadrion/producer';
import { resolveAssets } from '@kadrion/renderer-dom';
import { validateComposition } from '@kadrion/schema';
import { goldenTimestamps } from '@kadrion/test-fixtures';
import type { Frame } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { attackerHtml, ISOLATION_PROBE, SELF_NAVIGATION } from './probes.js';
import {
  customHtmlNode,
  decodePng,
  expectedBar,
  HEIGHT,
  measuredBar,
  OUTPUT_DIRECTORY,
  referenceResolver,
  variant,
  WIDTH,
  writeReport,
  type Draft,
  type DraftNode,
} from './support.js';

let chromium: LaunchedChromium;
const findings: Record<string, unknown> = {};

/**
 * The reference run has no network (D28.9): only then do the WebRTC checks
 * assert; elsewhere they report. `/proc/net/dev` lists the interfaces and their
 * counters on Linux.
 */
const network = networkFacts(Object.keys(networkInterfaces()));

function interfaceCounters(): Record<string, { rxBytes: number; txBytes: number }> | null {
  try {
    const lines = readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
    const counters: Record<string, { rxBytes: number; txBytes: number }> = {};
    for (const line of lines) {
      const [name, rest] = line.split(':');
      if (name === undefined || rest === undefined) continue;
      const fields = rest.trim().split(/\s+/).map(Number);
      counters[name.trim()] = { rxBytes: fields[0] ?? 0, txBytes: fields[8] ?? 0 };
    }
    return counters;
  } catch {
    return null;
  }
}

/** A loopback address, or an mDNS name that Chromium puts in place of a host address. */
function loopbackOrMdns(address: string): boolean {
  return /^127\./.test(address) || address === '::1' || /\.local$/.test(address);
}

beforeAll(async () => {
  chromium = await launchChromium();
});

afterAll(async () => {
  await chromium.browser.close();
  writeReport('custom-html-probes.json', findings);
});

/** Opens a session with `document`, loads it, and renders frame 0. */
async function loaded(document: unknown): Promise<RenderSession> {
  const result = validateComposition(document);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const session = await openRenderSession({
    chromium,
    width: WIDTH,
    height: HEIGHT,
    // As many as the document has (D29.7); the variants below add a second element.
    customHtmlNodes: (JSON.stringify(document).match(/"custom-html"/g) ?? []).length,
  });
  const assets = await resolveAssets(result.composition, referenceResolver, (bytes) =>
    Promise.resolve(sha256(bytes)),
  );
  await session.load(JSON.stringify(result.composition), assets);
  return session;
}

/** The frames of Custom HTML elements: the children of the render page. */
function elementFrames(session: RenderSession): Frame[] {
  return session.renderFrame.childFrames();
}

async function probeOf(frame: Frame): Promise<Record<string, unknown>> {
  await frame.waitForFunction(
    () => document.documentElement.hasAttribute('data-probe'),
    undefined,
    {
      timeout: 10_000,
    },
  );
  return JSON.parse(
    await frame.evaluate(() => document.documentElement.getAttribute('data-probe') ?? '{}'),
  ) as Record<string, unknown>;
}

const withProbe = (draft: Draft): void => {
  customHtmlNode(draft).html = ISOLATION_PROBE;
};

describe('from inside a Custom HTML element (§7.6)', () => {
  let probe: Record<string, unknown> = {};
  let requests: readonly string[] = [];
  let blocked: readonly string[] = [];
  let dialogs = 0;

  beforeAll(async () => {
    // Two elements, so that a sibling exists: the probe runs in both.
    const { document } = variant((draft) => {
      withProbe(draft);
      const scene = draft.scenes[0];
      const node = customHtmlNode(draft);
      scene?.nodes.push({ ...structuredClone(node), id: 'node-sibling' });
    });
    const session = await loaded(document);
    session.page.on('dialog', (dialog) => {
      dialogs += 1;
      void dialog.dismiss();
    });
    try {
      await session.frame(0, 0).catch(() => undefined);
      const [first] = elementFrames(session);
      if (first === undefined) throw new Error('No element frame.');
      probe = await probeOf(first);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await session.frame(75, 2_500_000);
      requests = [...session.requests];
      blocked = [...session.blockedRequests];
      findings.isolation = { probe, requests, blocked, dialogs, topUrl: session.page.url() };
    } finally {
      await session.close();
    }
  });

  it('has the opaque origin "null" (D23.1)', () => {
    expect(probe.origin).toBe('null');
  });

  it.each(['parent.document', 'top.document', 'top.location.href', 'sibling.document'])(
    'cannot read %s',
    (name) => {
      expect(probe[name]).toMatch(/^blocked:/);
    },
  );

  it.each(['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'caches'])(
    'cannot use %s',
    (name) => {
      expect(probe[name]).toMatch(/^blocked:/);
    },
  );

  it.each(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'image', 'font', 'Worker'])(
    'cannot reach the network or start a worker with %s',
    (name) => {
      expect(probe[name]).toMatch(/^blocked:/);
    },
  );

  it('opens no pop-up, shows no dialog, and cannot navigate the top page', () => {
    expect(probe['window.open']).toMatch(/^blocked:/);
    expect(dialogs).toBe(0);
    expect(probe['top.location=']).toMatch(/^blocked:/);
  });

  // Measured (D28.1): Chromium blocks these by policy and reports a violation, but
  // Playwright's interception still sees them; a local server received none.
  it('lets the page itself request nothing; the element’s attempts are aborted and recorded', () => {
    expect(requests).toEqual([]);
    findings.blockedRequests = blocked;
    for (const url of blocked) expect(url).toMatch(/^https:\/\/kadrion-probe\.invalid\//);
  });

  it('reaches nothing with WebRTC in the isolated run, and reports it elsewhere (D28.9)', () => {
    const webrtc = probe.webrtc as
      { candidates?: string[]; addresses?: string[]; gathering?: string } | string | undefined;
    // Recorded apart from requests and blockedRequests: ICE bypasses request interception.
    findings.webrtc = { network, probe: webrtc, counters: interfaceCounters() };
    console.info(`WebRTC from inside the element: ${JSON.stringify(findings.webrtc)}`);
    expect(webrtc).toBeDefined();
    if (!network.loopbackOnly) return;
    const candidates = typeof webrtc === 'object' ? (webrtc.candidates ?? []) : [];
    const addresses = typeof webrtc === 'object' ? (webrtc.addresses ?? []) : [];
    expect(
      candidates.filter((type) => type === 'srflx' || type === 'relay' || type === 'prflx'),
    ).toEqual([]);
    expect(addresses.filter((address) => !loopbackOrMdns(address))).toEqual([]);
    expect(Object.keys(interfaceCounters() ?? { lo: {} })).toEqual(['lo']);
  });
});

describe('DNS prefetching and preconnect from an element (D23.7, measured)', () => {
  it('are looked for in a net log of the browser', async () => {
    const log = join(OUTPUT_DIRECTORY, 'custom-html-netlog.json');
    const measuring = await launchChromium({
      extraArgs: [`--log-net-log=${log}`, '--net-log-capture-mode=Everything'],
    });
    try {
      const { document } = variant(withProbe);
      const result = validateComposition(document);
      if (!result.ok) throw new Error('invalid');
      const session = await openRenderSession({
        chromium: measuring,
        width: WIDTH,
        height: HEIGHT,
        customHtmlNodes: 1,
      });
      try {
        const assets = await resolveAssets(result.composition, referenceResolver, (bytes) =>
          Promise.resolve(sha256(bytes)),
        );
        await session.load(JSON.stringify(result.composition), assets);
        await session.frame(0, 0);
        const [frame] = elementFrames(session);
        if (frame !== undefined) await probeOf(frame);
      } finally {
        await session.close();
      }
    } finally {
      await measuring.browser.close();
    }
    const text = readFileSync(log, 'utf8');
    const hosts = [
      'kadrion-dns.invalid',
      'kadrion-preconnect.invalid',
      'kadrion-stun.invalid',
      'kadrion-probe.invalid',
    ];
    const seen = Object.fromEntries(hosts.map((host) => [host, text.includes(host)]));
    // Bytes that actually left a socket, by the event types the log's constants name.
    // Addresses alone would count the DNS configuration the container is given, which
    // is not traffic: in the isolated run there is no interface to carry it.
    const sent = Object.fromEntries(
      ['SOCKET_BYTES_SENT', 'UDP_BYTES_SENT'].map((name) => {
        const id = Number(new RegExp(`"${name}":\\s*(\\d+)`).exec(text)?.[1] ?? Number.NaN);
        const events = Number.isSafeInteger(id)
          ? [...text.matchAll(new RegExp(`"type":${String(id)}[,}]`, 'g'))].length
          : null;
        return [name, { id: Number.isSafeInteger(id) ? id : null, events }];
      }),
    );
    const addresses = [
      ...new Set([...text.matchAll(/"address":"([^"]+)"/g)].map((match) => match[1] ?? '')),
    ];
    findings.netLog = {
      seen,
      sent,
      addressesInConfiguration: addresses,
      bytes: text.length,
      network,
    };
    console.info(`Net log: ${JSON.stringify(findings.netLog)}`);
    expect(text.length).toBeGreaterThan(0);
    // D28.9: in the isolated run the browser sends no byte on any socket.
    if (network.loopbackOnly) {
      for (const [name, { id, events }] of Object.entries(sent)) {
        expect(id, name).not.toBeNull();
        expect(events, name).toBe(0);
      }
    }
  });
});

describe('self-navigation of an element (D23.7, measured)', () => {
  it.each(Object.keys(SELF_NAVIGATION))('%s', async (name) => {
    const html = SELF_NAVIGATION[name] ?? '';
    const { document } = variant((draft) => {
      customHtmlNode(draft).html = html;
    });
    const session = await loaded(document);
    const messages: string[] = [];
    session.page.on('console', (message) => messages.push(message.text()));
    let second: string;
    let urls: string[];
    try {
      await session.frame(0, 0).catch((reason: unknown) => {
        messages.push(`first frame: ${String((reason as { code?: string }).code)}`);
      });
      await new Promise((resolve) => setTimeout(resolve, 800));
      urls = elementFrames(session).map((frame) => frame.url());
      second = await session.frame(75, 2_500_000).then(
        () => 'resolved',
        (reason: unknown) => `rejected ${String((reason as { code?: string }).code)}`,
      );
    } finally {
      await session.close();
    }
    const outcome = {
      requests: [...session.requests],
      elementUrls: urls,
      secondFrame: second,
      console: messages.filter((text) =>
        /Refused|Content Security Policy|sandbox|navigat/i.test(text),
      ),
    };
    (findings.selfNavigation ??= {}) as Record<string, unknown>;
    (findings.selfNavigation as Record<string, unknown>)[name] = outcome;
    console.info(`self-navigation ${name}: ${JSON.stringify(outcome)}`);
    // What §7.3 requires, whatever the mechanism: no request reaches the network.
    expect(outcome.requests.filter((url) => url.startsWith('http'))).toEqual([]);
    // D23.9: the render ends with a typed error, never with a replaced document.
    expect(outcome.secondFrame).toBe('rejected custom-html-navigated');
  });
});

describe('the shell is the only document of a conforming element (D23.9)', () => {
  it('sees one load over a whole render, so the frame is never marked as navigated', async () => {
    const session = await loaded(variant(() => undefined).document);
    try {
      for (const { timeUs } of goldenTimestamps) {
        await session.frame(Math.round((timeUs * 30) / 1_000_000), timeUs);
      }
      const marked = await session.renderFrame.evaluate(
        () => document.querySelectorAll('iframe[data-kadrion-navigated]').length,
      );
      expect(marked).toBe(0);
    } finally {
      await session.close();
    }
  });
});

describe('a sibling cannot retime a conforming element (D23.3, §7.1)', () => {
  const victim = 'node-custom-html';
  const withAttacker = (silentVictim: boolean) =>
    variant((draft) => {
      const scene = draft.scenes[0];
      const node = customHtmlNode(draft);
      if (silentVictim) node.html = '<p>silent</p>';
      scene?.nodes.splice(scene.nodes.indexOf(node), 0, {
        ...structuredClone(node),
        id: 'node-attacker',
        html: attackerHtml(victim),
      } as DraftNode);
    });

  it('shows every golden time on the victim despite the attacker', async () => {
    const attacked = withAttacker(false);
    const result = await renderFrames({
      ...attacked,
      timesUs: goldenTimestamps.map(({ timeUs }) => timeUs),
      chromium,
    });
    for (const { timeUs, png } of result.frames) {
      expect(measuredBar(decodePng(png)), String(timeUs)).toBe(expectedBar(timeUs));
    }
  });

  it('does not accept the attacker’s answer in the name of a silent victim', async () => {
    await expect(
      renderFrames({ ...withAttacker(true), timesUs: [0], chromium, ackTimeoutMs: 300 }),
    ).rejects.toMatchObject({ code: 'custom-html-timeout' });
  });
});
