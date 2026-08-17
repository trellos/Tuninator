/**
 * Headless smoke test.
 *
 * Builds the demo, serves it with `vite preview`, drives it in headless Chromium
 * against the MOCK source (no microphone, no permission prompt) and asserts that
 *
 *   1. the page loads with no console errors and no page errors,
 *   2. both library streams actually flowed (pitchFrames + music events),
 *   3. the canvas really painted -- verified by reading pixels back, not by
 *      trusting that the element exists,
 *   4. the event log filled with note starts and ends,
 *
 * then saves `screenshot.png` in the repo root as visual evidence.
 *
 * `--live` additionally drives the REAL library against Chromium's fake audio
 * device, checking that a bad `workletUrl` surfaces `worklet-load-failed`
 * cleanly and that a good one reaches `listening`. That is kept out of the
 * default run because it depends on the sibling library checkout being built.
 *
 * Chromium is preinstalled; this never downloads a browser.
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers  ->  /opt/pw-browsers/chromium
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const PORT = Number(process.env["SMOKE_PORT"] ?? 4173);
const ORIGIN = `http://127.0.0.1:${PORT}`;
/** One full 16-beat loop at 90bpm, so the screenshot shows the whole phrase. */
const OBSERVE_MS = 11_500;
const INCLUDE_LIVE = process.argv.includes("--live");

function resolveChromium() {
  const explicit = process.env["CHROMIUM_PATH"];
  if (explicit && existsSync(explicit)) return explicit;
  const browsersPath = process.env["PLAYWRIGHT_BROWSERS_PATH"] ?? "/opt/pw-browsers";
  const candidate = path.join(browsersPath, "chromium");
  if (existsSync(candidate)) return candidate;
  return undefined; // fall back to playwright's own lookup
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`))
    );
  });
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`preview server did not come up at ${url}`);
}

const failures = [];
function check(label, ok, detail = "") {
  const line = `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`;
  console.log(line);
  if (!ok) failures.push(label);
}

async function main() {
  console.log("→ building");
  await run("npx", ["vite", "build", "--logLevel", "warn"]);

  console.log(`→ serving on ${ORIGIN}`);
  const server = spawn(
    "npx",
    ["vite", "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
  );
  server.stdout.on("data", () => {});
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  let browser;
  try {
    await waitForServer(ORIGIN);

    const executablePath = resolveChromium();
    console.log(`→ launching chromium (${executablePath ?? "playwright default"})`);
    browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      headless: true,
      args: [
        "--autoplay-policy=no-user-gesture-required",
        // Only relevant to --live: give the real library a synthetic input
        // device instead of a permission prompt it can never satisfy.
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 2, // also exercises the devicePixelRatio path
    });

    const consoleErrors = [];
    const pageErrors = [];
    const badResponses = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    // A bare "Failed to load resource" console error does not say *which*
    // resource; record the URL so a failure is actionable.
    page.on("response", (response) => {
      if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
    });

    // Mock source + metronome on, so the beat grid and the audio scheduler run.
    await page.goto(`${ORIGIN}/?mock=1&metronome=1`, { waitUntil: "load" });
    await page.waitForSelector("#timeline-canvas");

    check("page has a canvas", (await page.locator("#timeline-canvas").count()) === 1);
    check(
      "source badge reports the mock",
      (await page.locator("#source-badge").innerText()).includes("mock")
    );

    await page.click("#listen-btn");
    await page.waitForFunction(
      () => document.getElementById("state-pill")?.textContent === "listening",
      undefined,
      { timeout: 10_000 }
    );
    check("state reached `listening`", true);

    console.log(`→ observing for ${OBSERVE_MS}ms (one full 16-beat phrase)`);
    await page.waitForTimeout(OBSERVE_MS);

    // --- streams actually flowed -------------------------------------------
    const probe = await page.evaluate(() => window.__tuninatorDemo ?? null);
    check("pitchFrame stream flowed", (probe?.frames ?? 0) > 100, `frames=${probe?.frames}`);
    check(
      "music events started",
      (probe?.eventsStarted ?? 0) >= 8,
      `started=${probe?.eventsStarted}`
    );
    check("music events ended", (probe?.eventsEnded ?? 0) >= 6, `ended=${probe?.eventsEnded}`);
    check("no library error surfaced", probe?.lastError == null, JSON.stringify(probe?.lastError));

    // --- the canvas really painted -----------------------------------------
    const pixels = await page.evaluate(() => {
      const canvas = document.getElementById("timeline-canvas");
      if (!(canvas instanceof HTMLCanvasElement)) return null;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

      const colours = new Set();
      let nonBackground = 0;
      // The timeline paints #0d1117 as its ground.
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (Math.abs(r - 13) > 6 || Math.abs(g - 17) > 6 || Math.abs(b - 23) > 6) nonBackground += 1;
        if (colours.size < 4096) colours.add((r << 16) | (g << 8) | b);
      }
      return {
        width,
        height,
        cssWidth: canvas.clientWidth,
        nonBackground,
        total: data.length / 4,
        distinctColours: colours.size,
      };
    });

    check("canvas has a backing store", (pixels?.width ?? 0) > 0 && (pixels?.height ?? 0) > 0,
      `${pixels?.width}x${pixels?.height}`);
    check(
      "canvas is at device resolution (devicePixelRatio honoured)",
      (pixels?.width ?? 0) >= (pixels?.cssWidth ?? 0) * 1.5,
      `backing ${pixels?.width}px for ${pixels?.cssWidth}css`
    );
    const inkRatio = pixels ? pixels.nonBackground / pixels.total : 0;
    check(
      "timeline actually drew content",
      inkRatio > 0.01,
      `${(inkRatio * 100).toFixed(2)}% of pixels non-background`
    );
    check(
      "timeline drew coloured note bars, not just gridlines",
      (pixels?.distinctColours ?? 0) > 40,
      `${pixels?.distinctColours} distinct colours`
    );

    // --- panels populated ---------------------------------------------------
    const logLines = await page.locator("#event-log .log-line").count();
    check("event log filled", logLines >= 8, `${logLines} lines`);

    const frequencyText = await page.locator("#frequency-value").innerText();
    check("frequency readout is live", /\d/.test(frequencyText), frequencyText);

    const noteText = await page.locator("#note-name").innerText();
    check("note readout is live", noteText.trim() !== "" && noteText.trim() !== "—", noteText);

    // --- setMode() while listening -----------------------------------------
    await page.selectOption("#mode-select", "chords");
    await page.waitForTimeout(600);
    const stillListening =
      (await page.locator("#state-pill").innerText()).trim() === "listening";
    check("setMode() works while listening", stillListening);

    // --- error surface ------------------------------------------------------
    await page.goto(`${ORIGIN}/?mock=1&failWith=mic-permission-denied`, { waitUntil: "load" });
    await page.click("#listen-btn");
    await page.waitForSelector("#error-banner:not([hidden])", { timeout: 10_000 });
    const errorCode = (await page.locator("#error-code").innerText()).trim();
    const errorTitle = (await page.locator("#error-title").innerText()).trim();
    check(
      "denied mic permission shows a readable message",
      errorCode === "mic-permission-denied" && errorTitle.length > 0,
      `${errorCode} / "${errorTitle}"`
    );

    // --- the real library, against a fake input device (opt-in) -------------
    if (INCLUDE_LIVE) {
      await page.context().grantPermissions(["microphone"], { origin: ORIGIN });

      await page.goto(`${ORIGIN}/?mock=0&workletUrl=/definitely-not-here.js`, {
        waitUntil: "load",
      });
      await page.click("#listen-btn");
      await page.waitForSelector("#error-banner:not([hidden])", { timeout: 15_000 });
      const workletCode = (await page.locator("#error-code").innerText()).trim();
      check(
        "live: bad workletUrl reports `worklet-load-failed`",
        workletCode === "worklet-load-failed",
        workletCode
      );

      await page.goto(`${ORIGIN}/?mock=0`, { waitUntil: "load" });
      await page.click("#listen-btn");
      await page.waitForFunction(
        () => document.getElementById("state-pill")?.textContent === "listening",
        undefined,
        { timeout: 15_000 }
      );
      await page.waitForTimeout(4000);
      const liveProbe = await page.evaluate(() => window.__tuninatorDemo ?? null);
      check("live: real library reached `listening`", liveProbe?.state === "listening");
      check(
        "live: real library emitted pitch frames",
        (liveProbe?.frames ?? 0) > 50,
        `frames=${liveProbe?.frames}`
      );
    }

    // --- screenshot: back to the good path, one full phrase on screen -------
    await page.goto(`${ORIGIN}/?mock=1&metronome=1`, { waitUntil: "load" });
    await page.click("#listen-btn");
    await page.waitForTimeout(OBSERVE_MS);
    const shot = path.join(root, "screenshot.png");
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`→ screenshot saved to ${shot}`);

    check(
      "no console errors",
      consoleErrors.length === 0,
      [...consoleErrors, ...badResponses].join(" | ")
    );
    check("no failed network requests", badResponses.length === 0, badResponses.join(" | "));
    check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
  }

  console.log("");
  if (failures.length > 0) {
    console.error(`${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
    process.exitCode = 1;
  } else {
    console.log("all smoke checks passed");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
