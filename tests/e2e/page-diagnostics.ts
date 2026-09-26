// Per-engine browsers, and failure diagnostics for the pages they open.
//
// Specs that must run in both Chromium and WebKit take the `launchBrowser`
// fixture (see `withEngineBrowsers`): each worker keeps one browser per
// engine and each test gets fresh contexts in it, closed when the test ends.
// Launching a browser per test instead cost little at idle but spiked a
// WebKit's first page boot to 11-25 s on a loaded 4-worker runner, which ate
// the 30 s test budget.
//
// Those pages run outside the configured `page` fixture, so a Playwright
// trace of such a test records only the API calls — none of the page's
// console, errors, or network. When such a test fails once in a hundred runs
// (a WebKit page that never left "Connecting", say), there is nothing left
// to explain it. Global tracing is not the answer: it slowed the
// performance-budget suites past the CI time limit. Instead, `launchBrowser`
// records a cheap text log for every context the test opens — console
// messages, uncaught page errors, each non-asset
// request with its response status or failure, and the page lifecycle
// (visibility, pagehide/pageshow, online/offline) — and a spec that calls
// `attachPageDiagnosticsOnFailure(test)` attaches that log to the report only
// when the test did not pass. Passing runs keep nothing. Specs that drive
// several clients through the configured browser use
// `recordContextDiagnostics` for the same log: a retained trace of three
// contexts loading the dev bundle cost enough to time out
// personal-state.e2e.ts under load, where this log costs nothing measurable.

import { test as base, type Browser, type BrowserContext, type Page, type TestInfo, type TestType } from "@playwright/test";

type Engine = "chromium" | "webkit";

// Bounded, so a chatty page cannot grow a long test's memory without limit:
// the newest lines are the ones that explain how a failure ended.
const MAX_LINES = 2_000;

type Log = { started: number; lines: string[]; dropped: number };

const logs = new WeakMap<TestInfo, Log>();

function logFor(testInfo: TestInfo): Log {
  let log = logs.get(testInfo);
  if (!log) {
    log = { started: Date.now(), lines: [], dropped: 0 };
    logs.set(testInfo, log);
  }
  return log;
}

function push(log: Log, label: string, line: string): void {
  log.lines.push(`${String(Date.now() - log.started).padStart(7)}ms ${label} ${line}`);
  if (log.lines.length > MAX_LINES) {
    log.lines.shift();
    log.dropped += 1;
  }
}

// Terminal and session credentials ride query strings (`?t=`); a report is
// uploaded as a CI artifact, so the log keeps the path and names the keys.
function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const keys = [...url.searchParams.keys()];
    return `${url.pathname}${keys.length > 0 ? `?[${keys.join(",")}]` : ""}`;
  } catch {
    return raw.slice(0, 200);
  }
}

// Stylesheets, fonts, and images say nothing about why a page is stuck;
// documents, scripts, fetches, and event streams do.
const QUIET_RESOURCES = new Set(["stylesheet", "font", "image", "media", "manifest"]);

// Runs in the page before any of its own scripts. Reports through the
// console, which the context listener below already records.
function lifecycleProbe(): void {
  const report = (line: string) => console.debug(`[page-diagnostics] ${line}`);
  report(`document start visibility=${document.visibilityState}`);
  document.addEventListener("visibilitychange", () => report(`visibilitychange ${document.visibilityState}`));
  window.addEventListener("pageshow", event => report(`pageshow persisted=${event.persisted}`));
  window.addEventListener("pagehide", event => report(`pagehide persisted=${event.persisted}`));
  window.addEventListener("online", () => report("online"));
  window.addEventListener("offline", () => report("offline"));
  window.addEventListener("unhandledrejection", event => report(`unhandledrejection ${String(event.reason)}`));
}

async function instrumentContext(context: BrowserContext, log: Log, label: string): Promise<void> {
  context.on("console", message => {
    const location = message.location();
    const where = location.url ? ` (${redactUrl(location.url)}:${location.lineNumber})` : "";
    push(log, label, `console.${message.type()} ${message.text()}${where}`);
  });
  context.on("weberror", error => push(log, label, `pageerror ${error.error().stack ?? error.error().message}`));
  context.on("request", request => {
    if (QUIET_RESOURCES.has(request.resourceType())) return;
    push(log, label, `request ${request.method()} ${redactUrl(request.url())} [${request.resourceType()}]`);
  });
  context.on("response", response => {
    if (QUIET_RESOURCES.has(response.request().resourceType())) return;
    push(log, label, `response ${response.status()} ${response.request().method()} ${redactUrl(response.url())}`);
  });
  context.on("requestfailed", request => {
    push(log, label, `requestfailed ${request.method()} ${redactUrl(request.url())} [${request.resourceType()}] ${request.failure()?.errorText ?? ""}`);
  });
  const watchPage = (page: Page) => {
    page.on("framenavigated", frame => {
      if (frame === page.mainFrame()) push(log, label, `navigated ${redactUrl(frame.url())}`);
    });
    page.on("crash", () => push(log, label, "page crashed"));
    page.on("close", () => push(log, label, "page closed"));
  };
  // `browser.newPage` hands back a page its context already announced.
  for (const page of context.pages()) watchPage(page);
  context.on("page", watchPage);
  // Applies to pages already open, from their next navigation on.
  await context.addInitScript(lifecycleProbe);
}

/** What a spec's `launchBrowser(engine)` hands back: the worker's shared
 *  browser for that engine, seen through this test's own contexts. `close()`
 *  closes those contexts, not the browser. */
export type TestBrowser = Pick<Browser, "newContext" | "newPage" | "close" | "version">;

type EngineBrowserFixtures = {
  /** One browser per engine per worker, a fresh context per test (see the
   *  header). Replaces `({ chromium, webkit })[engine].launch()`. */
  launchBrowser: (engine: Engine) => Promise<TestBrowser>;
};

type EngineBrowserWorkerFixtures = {
  _webkitBrowser: () => Promise<Browser>;
};

/** Adds the `launchBrowser` fixture to `test`. Chromium is Playwright's own
 *  worker-scoped `browser` (the one behind the `page` fixture, which nearly
 *  every worker launches anyway), so a worker never runs two Chromiums;
 *  WebKit gets one worker-scoped browser of its own, launched on first use. */
export function withEngineBrowsers<T extends {}, W extends {}>(test: TestType<T, W>) {
  return test.extend<EngineBrowserFixtures, EngineBrowserWorkerFixtures>({
    _webkitBrowser: [async ({ playwright }, use) => {
      let launched: Promise<Browser> | undefined;
      await use(() => launched ??= playwright.webkit.launch());
      if (launched) await (await launched).close();
    }, { scope: "worker" }],

    launchBrowser: async ({ browser: chromiumBrowser, _webkitBrowser }, use, testInfo) => {
      if (chromiumBrowser.browserType().name() !== "chromium") {
        throw new Error("launchBrowser expects the configured browser to be Chromium");
      }
      const log = logFor(testInfo);
      const opened = new Set<BrowserContext>();
      let contexts = 0;
      await use(async engine => {
        const shared = engine === "chromium" ? chromiumBrowser : await _webkitBrowser();
        push(log, `[${engine}]`, `shared browser ${shared.version()}`);
        // Every context the test opens is watched from before its first
        // navigation, and closed with the test.
        const newContext = async (...args: Parameters<Browser["newContext"]>) => {
          const context = await shared.newContext(...args);
          opened.add(context);
          context.once("close", () => opened.delete(context));
          await instrumentContext(context, log, `[${engine}#${++contexts}]`);
          return context;
        };
        return {
          newContext,
          newPage: async (...args: Parameters<Browser["newPage"]>) => (await newContext(...args)).newPage(),
          close: async () => { await Promise.all([...opened].map(context => context.close())); },
          version: () => shared.version(),
        };
      });
      // A test that timed out never reached its own `finally`; its contexts
      // must not outlive it in the worker's browser.
      await Promise.all([...opened].map(context => context.close().catch(() => {})));
    },
  });
}

/** Records the same diagnostics for a context the test already holds — the
 *  `page` fixture's, or one from `browser.newContext()` — for specs that
 *  drive several clients at once. Call before the context navigates. */
export async function recordContextDiagnostics(context: BrowserContext, label: string): Promise<void> {
  await instrumentContext(context, logFor(base.info()), `[${label}]`);
}

/** Registers, for the calling spec file, an `afterEach` that attaches the
 *  diagnostics `launchBrowser` recorded — only when the test did not end as
 *  expected. Call once at the top level of the file. */
export function attachPageDiagnosticsOnFailure(test: TestType<any, any>): void {
  test.afterEach(async ({}, testInfo) => {
    const log = logs.get(testInfo);
    logs.delete(testInfo);
    if (!log || testInfo.status === testInfo.expectedStatus) return;
    const header = log.dropped > 0 ? [`(${log.dropped} earlier lines dropped)`] : [];
    await testInfo.attach("page-diagnostics", {
      body: [...header, ...log.lines].join("\n"),
      contentType: "text/plain",
    });
  });
}
