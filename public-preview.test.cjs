const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');

// Intercept the real production build; no secondary HTTP server is started.
async function builtPage(browser, origin) {
  const page = await browser.newPage();
  await page.route(`${origin}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/__local-model/')) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'NOT_FOUND' });
    const file = path.join(__dirname, 'dist', pathname === '/' ? 'index.html' : pathname);
    const contentType = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    try { await route.fulfill({ body: await fs.readFile(file), contentType }); }
    catch { await route.fulfill({ status: 404, body: 'Not found' }); }
  });
  return page;
}

for (const savedModel of ['', 'digitsflow/bonsai-8b:latest']) {
  test(`public preview blocks bridge calls (saved model: ${savedModel || 'none'})`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const origin = 'https://localpilot-preview.example';
      const page = await builtPage(browser, origin);
      const bridgeRequests = [];
      const errors = [];
      page.on('request', request => { if (request.url().includes('/__local-model/')) bridgeRequests.push(request.url()); });
      page.on('pageerror', error => errors.push(error.message));
      if (savedModel) await page.addInitScript(model => localStorage.setItem('localpilot.activeOllamaModel', model), savedModel);
      await page.goto(origin);
      await page.getByText('Public preview — local runtime required', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '↻ Refresh models', exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('textbox', { name: 'Message local model' }).isDisabled(), true);
      assert.equal(await page.getByRole('link', { name: 'open Personal Agent on this computer ↗' }).getAttribute('href'), 'http://localhost:4198');
      await page.getByRole('button', { name: 'Connection settings →', exact: true }).click();
      assert.equal(await page.getByText('LOCAL RUNTIME REQUIRED', { exact: true }).count(), 1);
      assert.equal(await page.getByRole('button', { name: 'Disconnect', exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: '↻ Check connection', exact: true }).isDisabled(), true);
      assert.match(await page.locator('.local-only-note').innerText(), savedModel ? /not connected/ : /No active model selected/);
      assert.doesNotMatch(await page.locator('body').innerText(), /non-JSON|requests routed through Ollama|PRIVATE & LOCAL/);
      await page.locator('.nav-item').filter({ hasText: 'Browser profiles' }).click();
      await page.getByRole('heading', { name: 'Open Personal Agent on your computer', exact: true }).waitFor();
      assert.doesNotMatch(await page.locator('body').innerText(), /not been implemented|no browser worker|DEMO · NOT CONFIGURED/);
      await page.locator('.nav-item').filter({ hasText: 'Settings' }).click();
      assert.equal(await page.locator('input[type=password]').count(), 0);
      assert.deepEqual(bridgeRequests, []);
      assert.deepEqual(errors, []);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } finally { await browser.close(); }
  });
}

test('local bridge errors stay visible and empty model status is explicit', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const origin = 'http://localhost:4198';
    const page = await builtPage(browser, origin);
    await page.route('**/__local-model/**', route => route.fulfill({ json: route.request().url().endsWith('/health') ? { ok: true } : route.request().url().endsWith('/models') ? { models: [{ name: 'bonsai:latest' }], cloudModels: [] } : {} }));
    await page.goto(origin);
    await page.waitForFunction(() => !document.querySelector('#local-model-choice').disabled);
    await page.getByRole('button', { name: 'Connection settings →', exact: true }).click();
    assert.equal(await page.getByText('OLLAMA CONNECTED', { exact: true }).count(), 1);
    assert.equal(await page.getByText('No active model selected', { exact: true }).count(), 1);
    await page.route('**/__local-model/health', route => route.fulfill({ status: 502, json: { error: 'Ollama is unreachable at 127.0.0.1:11434.' } }));
    await page.getByRole('button', { name: '↻ Check connection', exact: true }).click();
    await page.getByText('Ollama is unreachable at 127.0.0.1:11434.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Disconnect', exact: true }).isDisabled(), true);
  } finally { await browser.close(); }
});
