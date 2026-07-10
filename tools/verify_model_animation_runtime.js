const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_URL = 'http://localhost:5173/';
const DEFAULT_DURATION_MS = 48000;
const DEFAULT_INTERVAL_MS = 2000;
const MOTOR_KEYS = [
  'rear_fan_speed',
  'front_fan_speed',
  'oil_stir_1_speed',
  'oil_stir_2_speed',
  'oil_stir_3_speed',
  'oil_stir_4_speed'
];

function round(value, digits = 3) {
  return Number(Number(value || 0).toFixed(digits));
}

function findChromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH && fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM_PATH)) {
    return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  const baseDir = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!baseDir || !fs.existsSync(baseDir)) return null;

  const candidates = fs.readdirSync(baseDir)
    .filter(name => /^chromium-\d+$/.test(name))
    .map(name => {
      const match = name.match(/(\d+)$/);
      const exe = path.join(baseDir, name, 'chrome-win64', 'chrome.exe');
      return { revision: match ? Number(match[1]) : 0, exe };
    })
    .filter(item => fs.existsSync(item.exe))
    .sort((a, b) => b.revision - a.revision);

  return candidates[0]?.exe || null;
}

function minMax(values) {
  if (!values.length) return { min: null, max: null };
  return { min: round(Math.min(...values)), max: round(Math.max(...values)) };
}

function uniqueBools(values) {
  return [...new Set(values.filter(value => typeof value === 'boolean'))];
}

function summarize(samples) {
  const ids = samples[0]?.devices?.map(device => device.id) || [];
  const summary = ids.map(id => {
    const records = samples
      .map(sample => sample.devices.find(device => device.id === id))
      .filter(Boolean);
    const first = records[0] || {};
    const valuesFor = key => records
      .map(item => item.bindings?.[key]?.value)
      .filter(value => Number.isFinite(value));
    const speedsFor = key => records
      .map(item => item.bindings?.[key]?.speed)
      .filter(value => Number.isFinite(value));

    const frontOffset = minMax(valuesFor('front_door_open'));
    const middleOffset = minMax(valuesFor('middle_door_open'));
    const frontSignals = uniqueBools(records.map(item => item.signal?.front));
    const middleSignals = uniqueBools(records.map(item => item.signal?.middle));
    const motors = {};

    MOTOR_KEYS.forEach(key => {
      const values = valuesFor(key);
      const speeds = speedsFor(key);
      const mm = minMax(values);
      const rotationDelta = round((mm.max ?? 0) - (mm.min ?? 0));
      motors[key] = {
        rotationDelta,
        maxSpeed: speeds.length ? round(Math.max(...speeds)) : null,
        moved: rotationDelta > 0.2,
        sawSpeed: speeds.some(speed => Math.abs(speed) > 0.01)
      };
    });

    const frontMatchesSignal = records.every(item => {
      const signal = item.signal?.front;
      const offset = item.bindings?.front_door_open?.value;
      if (typeof signal !== 'boolean' || !Number.isFinite(offset)) return false;
      return signal ? offset > 0.7 : offset < 0.05;
    });
    const middleMatchesSignal = records.every(item => {
      const signal = item.signal?.middle;
      const offset = item.bindings?.middle_door_open?.value;
      if (typeof signal !== 'boolean' || !Number.isFinite(offset)) return false;
      return signal ? offset > 0.55 : offset < 0.05;
    });

    return {
      id,
      bindingCount: first.bindingCount || 0,
      frontSignals,
      middleSignals,
      frontOffset,
      middleOffset,
      frontOk: frontSignals.length === 2 && frontMatchesSignal,
      middleOk: middleSignals.length === 2 && middleMatchesSignal,
      motors,
      allMotorOk: MOTOR_KEYS.every(key => motors[key].moved && motors[key].sawSpeed)
    };
  });

  return {
    deviceCount: summary.length,
    overallOk: summary.length === 7 && summary.every(item => (
      item.bindingCount >= 15
      && item.frontOk
      && item.middleOk
      && item.allMotorOk
    )),
    summary
  };
}

async function readRuntimeSample(page) {
  return page.evaluate((motorKeys) => {
    const round = (value, digits = 3) => Number(Number(value || 0).toFixed(digits));
    const runtime = window.__DASHBOARD_RUNTIME__;
    const entries = Array.from(runtime?.furnaces?.entries?.() || [])
      .filter(([, model]) => (model?.bindingStates?.length || 0) >= 15)
      .sort(([a], [b]) => String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true }));

    const readBinding = (model, key) => {
      const state = (model?.bindingStates || []).find(item => item?.binding?.source_key === key);
      if (!state) return null;
      const axis = state.axis;
      const value = state.binding.action === 'translate'
        ? state.target.position[axis] - state.basePosition[axis]
        : state.target.rotation[axis];
      return {
        action: state.binding.action,
        value: round(value),
        speed: round(state.speed || 0)
      };
    };

    return entries.map(([id, model]) => {
      const data = model?.lastRealtimeData || {};
      const bindings = {
        front_door_open: readBinding(model, 'front_door_open'),
        middle_door_open: readBinding(model, 'middle_door_open')
      };
      motorKeys.forEach(key => {
        bindings[key] = readBinding(model, key);
      });
      return {
        id,
        bindingCount: model?.bindingStates?.length || 0,
        signal: {
          front: data.doors?.front_door_open,
          middle: data.doors?.middle_door_open,
          rearFanSpeed: data.motors?.rear_fan_speed,
          frontFanSpeed: data.motors?.front_fan_speed,
          oil1: data.motors?.oil_stir_1_speed,
          oil2: data.motors?.oil_stir_2_speed,
          oil3: data.motors?.oil_stir_3_speed,
          oil4: data.motors?.oil_stir_4_speed
        },
        bindings
      };
    });
  }, MOTOR_KEYS);
}

async function main() {
  const url = process.argv[2] || DEFAULT_URL;
  const durationMs = Number(process.argv[3] || DEFAULT_DURATION_MS);
  const intervalMs = Number(process.argv[4] || DEFAULT_INTERVAL_MS);
  const executablePath = findChromiumExecutable();
  if (!executablePath) {
    throw new Error('没有找到 Playwright Chromium，可设置 PLAYWRIGHT_CHROMIUM_PATH 指向 chrome.exe');
  }

  const outputDir = path.join(ROOT_DIR, 'output', 'playwright');
  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--ignore-gpu-blocklist', '--use-gl=swiftshader']
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleMessages = [];
  page.on('console', msg => {
    if (['error', 'warning'].includes(msg.type())) {
      consoleMessages.push({ type: msg.type(), text: msg.text() });
    }
  });
  page.on('pageerror', error => {
    consoleMessages.push({ type: 'pageerror', text: error.message });
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => {
    const models = Array.from(window.__DASHBOARD_RUNTIME__?.furnaces?.values?.() || []);
    return models.filter(model => (model?.bindingStates?.length || 0) >= 15).length >= 7;
  }, { timeout: 60000 });
  await page.waitForFunction(() => {
    const models = Array.from(window.__DASHBOARD_RUNTIME__?.furnaces?.values?.() || [])
      .filter(model => (model?.bindingStates?.length || 0) >= 15);
    return models.length >= 7 && models.every(model => (
      typeof model.lastRealtimeData?.doors?.front_door_open === 'boolean'
      && typeof model.lastRealtimeData?.doors?.middle_door_open === 'boolean'
    ));
  }, { timeout: 60000 });

  const samples = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < durationMs) {
    samples.push({
      elapsedMs: Date.now() - startedAt,
      devices: await readRuntimeSample(page)
    });
    await page.waitForTimeout(intervalMs);
  }

  await page.screenshot({ path: path.join(outputDir, 'furnace-animation-runtime.png'), fullPage: false });
  const result = {
    url,
    durationMs,
    intervalMs,
    sampleCount: samples.length,
    chromium: executablePath,
    ...summarize(samples),
    consoleMessages
  };
  fs.writeFileSync(
    path.join(outputDir, 'furnace-animation-runtime-summary.json'),
    JSON.stringify(result, null, 2),
    'utf8'
  );
  await browser.close();
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
