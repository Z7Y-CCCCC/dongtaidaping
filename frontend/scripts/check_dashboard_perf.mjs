import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:5173/';
const outputDir = process.argv[3] || 'C:/tmp/daping-perf';

fs.mkdirSync(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

const consoleMessages = [];
page.on('console', (message) => {
  if (['error', 'warning'].includes(message.type())) {
    consoleMessages.push(`${message.type()}: ${message.text()}`);
  }
});

await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForSelector('canvas', { timeout: 30000 });
await page.waitForTimeout(5000);

const metrics = await page.evaluate(async () => {
  const canvas = document.querySelector('canvas');
  const ctx = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  const canvasRect = canvas.getBoundingClientRect();

  const fps = await new Promise((resolve) => {
    let frames = 0;
    const start = performance.now();
    function tick(now) {
      frames += 1;
      if (now - start >= 3000) {
        resolve(frames / ((now - start) / 1000));
      } else {
        requestAnimationFrame(tick);
      }
    }
    requestAnimationFrame(tick);
  });
  const rendererInfo = window.__DASHBOARD_RENDERER_INFO__ || null;

  return {
    fps: Number(fps.toFixed(1)),
    rendered: !!rendererInfo && rendererInfo.calls > 0,
    canvas: {
      width: canvas.width,
      height: canvas.height,
      clientWidth: Math.round(canvasRect.width),
      clientHeight: Math.round(canvasRect.height)
    },
    webgl: {
      version: ctx ? ctx.getParameter(ctx.VERSION) : null,
      vendor: ctx ? ctx.getParameter(ctx.VENDOR) : null,
      renderer: ctx ? ctx.getParameter(ctx.RENDERER) : null
    },
    rendererInfo
  };
});

const screenshotPath = path.join(outputDir, 'dashboard-1920x1080.png');
await page.screenshot({ path: screenshotPath, fullPage: false });
await browser.close();

console.log(JSON.stringify({
  url,
  screenshotPath,
  metrics,
  consoleMessages: consoleMessages.slice(-20)
}, null, 2));
