/**
 * The pinned render environment (D26): the one way to launch Chromium and to
 * open a page, for the Producer and for every browser test, and the manifest
 * that makes the pins observable. The constants repeat what `playwright-core`
 * 1.63.0 pins in its `browsers.json`; `launchChromium` refuses to run when the
 * installed Playwright or the running browser say anything else.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { chromium, type Browser, type BrowserContextOptions } from 'playwright-core';

import { ProducerError } from './errors.js';

/** D26.1. */
export const PLAYWRIGHT_CORE_VERSION = '1.63.0';
export const CHROMIUM_REVISION = '1243';
export const CHROMIUM_VERSION = '153.0.8010.12';
/** The new headless mode of the full Chrome-for-Testing binary, not `chromium-headless-shell`. */
export const CHROMIUM_CHANNEL = 'chromium';

/** D26.2: the only environment whose frames are golden. */
export const PINNED_IMAGE =
  'mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27';
export const PINNED_PLATFORM = 'linux/amd64';
/** The variable a pinned run sets to `PINNED_IMAGE` (D26.2). */
export const PINNED_IMAGE_VARIABLE = 'KADRION_PINNED_IMAGE';

/** D26.3: added to Playwright's own default arguments. */
export const CHROMIUM_ARGS: readonly string[] = Object.freeze([
  '--force-color-profile=srgb',
  '--disable-lcd-text',
  '--hide-scrollbars',
  '--mute-audio',
]);
export const LOCALE = 'en-US';
export const TIMEZONE = 'UTC';
export const DEVICE_SCALE_FACTOR = 1;

interface BrowsersJson {
  readonly browsers: readonly { name: string; revision: string; browserVersion?: string }[];
}

/** What the installed `playwright-core` says about itself and its Chromium. */
export function installedPlaywright(): {
  readonly version: string;
  readonly revision: string | null;
  readonly browserVersion: string | null;
} {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('playwright-core/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string };
  const browsers = JSON.parse(
    readFileSync(join(dirname(manifestPath), 'browsers.json'), 'utf8'),
  ) as BrowsersJson;
  const entry = browsers.browsers.find((browser) => browser.name === 'chromium');
  return {
    version: manifest.version,
    revision: entry?.revision ?? null,
    browserVersion: entry?.browserVersion ?? null,
  };
}

/** The context of every page: the composition's size in CSS pixels at scale 1 (D26.3). */
export function contextOptions(width: number, height: number): BrowserContextOptions {
  return {
    viewport: { width, height },
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    locale: LOCALE,
    timezoneId: TIMEZONE,
    colorScheme: 'light',
    reducedMotion: 'no-preference',
  };
}

export interface LaunchedChromium {
  readonly browser: Browser;
  /** What `browser.version()` reported. */
  readonly reportedVersion: string;
}

export interface LaunchOptions {
  /** Additional arguments for a measurement (for example a net log); never for a golden render. */
  readonly extraArgs?: readonly string[];
}

/**
 * Launches the pinned Chromium (D26.3) after checking that the installed
 * Playwright is the pinned one, and checks what the running browser reports.
 */
export async function launchChromium(options: LaunchOptions = {}): Promise<LaunchedChromium> {
  const installed = installedPlaywright();
  if (
    installed.version !== PLAYWRIGHT_CORE_VERSION ||
    installed.revision !== CHROMIUM_REVISION ||
    installed.browserVersion !== CHROMIUM_VERSION
  ) {
    throw new ProducerError(
      'chromium-mismatch',
      `playwright-core ${installed.version} pins Chromium ${String(installed.revision)} (${String(installed.browserVersion)}); expected ${PLAYWRIGHT_CORE_VERSION}, ${CHROMIUM_REVISION} (${CHROMIUM_VERSION}).`,
    );
  }
  const executable = chromium.executablePath();
  if (!existsSync(executable)) {
    throw new ProducerError(
      'chromium-missing',
      `The pinned Chromium is not installed at ${executable}. Run "corepack pnpm exec playwright-core install chromium --no-shell".`,
    );
  }
  let browser: Browser;
  try {
    browser = await chromium.launch({
      channel: CHROMIUM_CHANNEL,
      args: [...CHROMIUM_ARGS, ...(options.extraArgs ?? [])],
    });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message.split('\n')[0] : String(reason);
    throw new ProducerError(
      'chromium-missing',
      `The pinned Chromium did not start: ${message ?? ''}`,
    );
  }
  const reportedVersion = browser.version();
  if (reportedVersion !== CHROMIUM_VERSION) {
    await browser.close();
    throw new ProducerError(
      'chromium-mismatch',
      `The browser reports ${reportedVersion}, not ${CHROMIUM_VERSION}.`,
    );
  }
  return { browser, reportedVersion };
}

export interface EnvironmentFacts {
  readonly image: string | undefined;
  readonly platform: string;
  readonly arch: string;
  readonly reportedVersion: string;
  /** Names of the network interfaces of the process, as `os.networkInterfaces()` lists them. */
  readonly networkInterfaces: readonly string[];
}

/**
 * What the process can reach (D28.9): interface names only, never addresses,
 * because the manifest may be committed. `loopbackOnly` holds in a container
 * run with `--network none`, the reference run. It is a tripwire that records
 * the run; the boundary itself is the container's missing network.
 */
export interface NetworkFacts {
  readonly interfaces: readonly string[];
  readonly loopbackOnly: boolean;
}

/**
 * The interface names of this host, as `os.networkInterfaces()` lists them.
 * The render and the export read them here; their unit tests inject a list
 * instead, because a host may refuse the call (`uv_interface_addresses`). A
 * failure propagates: nothing is assumed about a network that was not read.
 */
export function hostNetworkInterfaces(
  read: () => Readonly<Record<string, unknown>> = networkInterfaces,
): string[] {
  return Object.keys(read());
}

export function networkFacts(interfaces: readonly string[]): NetworkFacts {
  const sorted = [...interfaces].sort();
  return { interfaces: sorted, loopbackOnly: sorted.length === 1 && sorted[0] === 'lo' };
}

/** D26.2: pinned only in the container, on linux/x64, with the expected browser. */
export function isPinned(facts: Omit<EnvironmentFacts, 'networkInterfaces'>): boolean {
  return (
    facts.image === PINNED_IMAGE &&
    facts.platform === 'linux' &&
    facts.arch === 'x64' &&
    facts.reportedVersion === CHROMIUM_VERSION
  );
}

export interface EnvironmentManifest {
  readonly pinned: boolean;
  readonly image: string | null;
  /** The platform a pinned run must have (D26.2); `os` and `arch` are this run's. */
  readonly pinnedPlatform: string;
  readonly os: string;
  readonly arch: string;
  readonly node: string;
  readonly playwrightCore: string;
  readonly chromiumRevision: string;
  readonly chromiumVersion: string;
  readonly reportedVersion: string;
  readonly channel: string;
  readonly args: readonly string[];
  readonly locale: string;
  readonly timezone: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  /** D28.9. */
  readonly network: NetworkFacts;
}

/**
 * Why this environment may not write golden frames, or `null` (D26.5, D28.9):
 * they come from the pinned container only, and only from a run without a
 * network. `node --run goldens:update` prints this and refuses.
 */
export function goldenRefusal(environment: EnvironmentManifest): string | null {
  if (!environment.pinned) {
    return `this is not the pinned environment (${environment.os}/${environment.arch}, image ${String(environment.image)}); see docs/adr/D26-pinned-render-environment.md`;
  }
  if (!environment.network.loopbackOnly) {
    return `the run has a network (${environment.network.interfaces.join(', ')}), and the reference run has none; see docs/adr/D28-producer-frame-capture.md, 28.9`;
  }
  return null;
}

/** The environment manifest of D26.4 for a launched browser and a composition size. */
export function environmentManifest(
  reportedVersion: string,
  viewport: { readonly width: number; readonly height: number },
  facts: Partial<EnvironmentFacts> = {},
): EnvironmentManifest {
  const image = facts.image ?? process.env[PINNED_IMAGE_VARIABLE];
  const platform = facts.platform ?? process.platform;
  const arch = facts.arch ?? process.arch;
  return {
    pinned: isPinned({ image, platform, arch, reportedVersion }),
    image: image ?? null,
    pinnedPlatform: PINNED_PLATFORM,
    os: platform,
    arch,
    node: process.version,
    playwrightCore: installedPlaywright().version,
    chromiumRevision: CHROMIUM_REVISION,
    chromiumVersion: CHROMIUM_VERSION,
    reportedVersion,
    channel: CHROMIUM_CHANNEL,
    args: CHROMIUM_ARGS,
    locale: LOCALE,
    timezone: TIMEZONE,
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    network: networkFacts(facts.networkInterfaces ?? hostNetworkInterfaces()),
  };
}
