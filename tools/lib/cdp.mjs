/**
 * THE CDP PROLOGUE, FACTORED OUT ONCE.
 *
 * `browserCheck`, `fieldCheck`, `configCheck`, `saveTransferCheck` and
 * `densityCheck` each carry their own copy of the same ~90 lines: spawn a
 * headed Chrome on an ephemeral debugging port, scrape the `ws://` URL off
 * stderr, open a raw WebSocket, speak CDP by hand, attach to the page target,
 * enable `Runtime` and `Page`. Five copies were tolerable while each tool ran
 * once; a search harness calls this on every run and wants the boot to be one
 * thing that is known to work.
 *
 * THE FIVE EXISTING TOOLS ARE DELIBERATELY NOT MIGRATED ONTO THIS. They are the
 * verification suite -- they are what says the port is still correct -- and
 * rewriting their boot is a change whose only failure mode is that the suite
 * stops catching things. New code uses this; old code keeps its copy.
 *
 * HEADED, ALWAYS. Headless Chrome returns a null adapter, so there is no
 * WebGPU device and nothing compiles. That is the whole reason none of this can
 * live in `npm test`. `--enable-unsafe-webgpu` is passed for the same reason
 * every sibling tool passes it.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/**
 * Chrome's location, per platform, with `CHROME_PATH` as the override.
 *
 * `browserCheck.mjs` hardcodes the Windows path and reads the env var as an
 * escape hatch, which means every macOS invocation needs the variable set.
 * `densityCheck.mjs` fixed that for itself; this is its version, shared.
 */
export const CHROME_PATH =
  process.env.CHROME_PATH ??
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : process.platform === 'win32'
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      : '/usr/bin/google-chrome');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Read `--name value` out of `process.argv`, with a fallback.
 *
 * Every tool in this directory hand-rolls this. It is four lines and it is
 * wrong in the same way each time when the flag is last and has no value, so
 * the guard lives here once.
 */
export function flagReader(argv = process.argv.slice(2)) {
  return {
    argv,
    str: (name, fallback = null) => {
      const i = argv.indexOf(name);
      return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
    },
    num: (name, fallback) => {
      const i = argv.indexOf(name);
      if (i < 0 || argv[i + 1] === undefined) return fallback;
      const v = Number(argv[i + 1]);
      return Number.isFinite(v) ? v : fallback;
    },
    has: (name) => argv.includes(name),
  };
}

/**
 * Boot a headed Chrome on `url` and return a live CDP session.
 *
 * The returned object is everything the callers of the five copies actually
 * used, and nothing more:
 *
 *   send(method, params)   raw CDP, already carrying the page session id
 *   evaluate(expression)   `Runtime.evaluate`, by value, awaiting promises
 *   screenshot()           base64 PNG
 *   logs                   a live array of console lines, `{level, text}`
 *   close()                kill Chrome, remove the temp profile
 *
 * `evaluate` REJECTS on a page-side exception rather than returning undefined.
 * The copies each call their own `die()` here, which is right for a one-shot
 * checker and wrong for a harness that wants to score the candidate, record the
 * failure and keep going.
 */
export async function launch(
  url,
  {
    windowSize = '1280,900',
    bootMs = 6000,
    shotTimeoutMs = 20000,
    /**
     * THE PROFILE PREFIX IS HOW A WINDOW SAYS "DO NOT KILL ME".
     *
     * Automated runs sweep away stragglers by matching this in the process
     * list. An interactive window opened for a person to drive must therefore
     * NOT share the prefix, or the next run's cleanup closes the app out from
     * under them mid-click. That happened; it looked exactly like the app
     * crashing, and it was not.
     */
    profilePrefix = 'fluoddity-cdp-',
  } = {},
) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), profilePrefix));
  const chrome = spawn(
    CHROME_PATH,
    [
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--enable-unsafe-webgpu',
      `--window-size=${windowSize}`,
      url,
    ],
    // DETACHED SO THE WHOLE GROUP CAN BE KILLED. Chrome forks a zygote and a
    // GPU process, and killing only the parent leaves those alive -- holding
    // the GPU, still rendering the page at full rate. A search that leaked one
    // per run would slow to a crawl for reasons that look like the harness
    // being slow. Measured: two survivors after an interrupted run were enough
    // to stall the next one indefinitely.
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );

  let closed = false;
  let onExit;
  let onSigint;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    // Declared below; safe because `cleanup` only ever runs after `launch`
    // has returned or thrown, by which point both exist.
    try {
      process.off('exit', onExit);
      process.off('SIGINT', onSigint);
    } catch {
      /* never registered, on the early-failure path */
    }
    try {
      // Negative pid is the process GROUP. SIGKILL rather than SIGTERM because
      // a Chrome asked politely may wait on a beforeunload handler.
      process.kill(-chrome.pid, 'SIGKILL');
    } catch {
      try {
        chrome.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  // An interrupted run must not leak a browser either. Without this, Ctrl-C
  // during a long sweep leaves the GPU occupied until the machine is rebooted.
  //
  // REMOVED AGAIN IN `cleanup`. A sweep that replaces a wedged browser launches
  // many sessions in one process, and registering a pair of process listeners
  // per launch without removing them warns at ten and leaks for the rest of the
  // run -- node's own MaxListenersExceededWarning is the symptom.
  onExit = () => cleanup();
  onSigint = () => {
    cleanup();
    process.exit(130);
  };
  process.once('exit', onExit);
  process.once('SIGINT', onSigint);

  let browserWs;
  try {
    browserWs = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Chrome did not report a debugging port within 20s')),
        20000,
      );
      chrome.stderr.on('data', (buf) => {
        const m = String(buf).match(/ws:\/\/\S+/);
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      });
      chrome.on('error', reject);
    });
  } catch (e) {
    cleanup();
    throw e;
  }

  const ws = new WebSocket(browserWs);
  await once(ws, 'open');

  let nextId = 1;
  const pending = new Map();
  const logs = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push({
        level: msg.params.type,
        text: (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '),
      });
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      logs.push({ level: 'error', text: d?.exception?.description ?? d?.text ?? 'exception' });
    }
  });

  const rawSend = (method, params = {}, sid) => {
    const id = nextId++;
    const payload = { id, method, params };
    if (sid) payload.sessionId = sid;
    ws.send(JSON.stringify(payload));
    return new Promise((resolve) => pending.set(id, resolve));
  };

  const { result: targets } = await rawSend('Target.getTargets');
  const page = targets.targetInfos.find((t) => t.type === 'page');
  if (!page) {
    cleanup();
    throw new Error('No page target -- Chrome opened nothing.');
  }
  const attached = await rawSend('Target.attachToTarget', {
    targetId: page.targetId,
    flatten: true,
  });
  const sessionId = attached.result.sessionId;

  await rawSend('Runtime.enable', {}, sessionId);
  await rawSend('Page.enable', {}, sessionId);

  // Device acquisition plus eleven pipeline compilations. There is no signal to
  // poll for THIS part -- `waitForBus` covers the app being up, but the bus
  // appears before the pipelines finish.
  await sleep(bootMs);

  const send = (method, params = {}) => rawSend(method, params, sessionId);

  /**
   * Every CDP call gets a deadline.
   *
   * A page-side promise that never settles -- a rejected `await` inside an
   * `awaitPromise` evaluate, a frame callback that never fires -- leaves the
   * driving `send` pending forever, and node simply goes idle. There is no
   * error, no stack, and no indication of WHICH call is stuck: the process just
   * sits there while Chrome keeps rendering. That failure cost real time to
   * diagnose here, so it is now impossible: a call that overruns names itself.
   */
  const DEFAULT_TIMEOUT_MS = 120000;
  const withDeadline = (promise, label, ms = DEFAULT_TIMEOUT_MS) => {
    let timer;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`page call timed out after ${ms}ms: ${label}`)),
          ms,
        );
      }),
    ]);
  };

  const evaluate = async (expression, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
    // The label is the head of the expression: enough to name the call without
    // pasting a two-megabyte screenshot into an error message.
    const label = expression.replace(/\s+/g, ' ').slice(0, 80);
    const r = await withDeadline(
      send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }),
      label,
      timeoutMs,
    );
    const details = r.result?.exceptionDetails;
    if (details) {
      const text = details.exception?.description ?? details.text ?? JSON.stringify(details);
      throw new Error(`page evaluate failed: ${text}`);
    }
    return r.result?.result?.value;
  };

  /**
   * A screenshot, with a SHORT deadline.
   *
   * A healthy capture takes ~300ms. A wedged one never returns at all, so every
   * millisecond of the timeout past a healthy capture is pure waste -- and in a
   * search where a meaningful fraction of candidates wedge, that waste is most
   * of the wall clock. Two seconds would be defensible; twenty is generous
   * enough that a genuinely slow frame is never mistaken for a dead one.
   */
  /**
   * Is the PAGE alive, as opposed to the capture being stuck?
   *
   * These are different failures and confusing them is expensive. A wedged
   * renderer answers nothing at all. A perfectly healthy page whose window has
   * been occluded also fails to screenshot -- the compositor stops committing
   * frames to the surface, so `Page.captureScreenshot` waits forever -- while
   * `Runtime.evaluate` keeps replying instantly.
   *
   * Treating the second as the first is what made this harness kill browsers
   * that were visibly still running.
   */
  const pageResponds = async (ms = 4000) => {
    try {
      const r = await withDeadline(
        send('Runtime.evaluate', { expression: '1+1', returnByValue: true }),
        'liveness probe',
        ms,
      );
      return r.result?.result?.value === 2;
    } catch {
      return false;
    }
  };

  /**
   * A screenshot, retried once from the RENDERER when the surface will not
   * yield one.
   *
   * `fromSurface: false` captures through the renderer instead of the window's
   * compositor, which is exactly the path that survives an occluded or
   * backgrounded window.
   */
  const screenshot = async ({ timeoutMs = shotTimeoutMs } = {}) => {
    try {
      const r = await withDeadline(
        send('Page.captureScreenshot', { format: 'png' }),
        'Page.captureScreenshot',
        timeoutMs,
      );
      return r.result?.data ?? null;
    } catch (surfaceError) {
      if (!(await pageResponds())) throw surfaceError; // genuinely wedged
      await send('Page.bringToFront').catch(() => {});
      const r = await withDeadline(
        send('Page.captureScreenshot', { format: 'png', fromSurface: false }),
        'Page.captureScreenshot(fromSurface:false)',
        timeoutMs,
      );
      const data = r.result?.data ?? null;
      if (data === null) throw surfaceError;
      return data;
    }
  };

  return { send, evaluate, screenshot, pageResponds, logs, sessionId, close: cleanup, chrome };
}

/**
 * Poll until `window.__fluoddity` exists, rather than sleeping at it.
 *
 * The bus is the one signal that says the Orchestrator was constructed. It is
 * not a signal that the pipelines are built -- see `bootMs` above -- but it is
 * the difference between "the page is up" and "the page 404'd because
 * `npm run dev` is not running", which is the failure worth naming.
 */
export async function waitForBus(session, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ready = await session.evaluate('typeof window.__fluoddity === "object"');
    if (ready) return;
    if (Date.now() > deadline) {
      throw new Error(
        'window.__fluoddity never appeared. Is `npm run dev` running, and does the URL carry ?bus ?',
      );
    }
    await sleep(250);
  }
}

/** Console lines that mean the run is void, in the shape every tool checks. */
export function consoleErrors(logs) {
  return logs.filter((l) => l.level === 'error' || /error|failed|Uncaught/i.test(l.text));
}
