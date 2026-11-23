const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

test('front-page chat and model picker retain conversation and fit mobile', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/__local-model/health', route => route.fulfill({ json: { ok: true } }));
    await page.route('**/__local-model/settings', route => route.fulfill({ json: {} }));
    await page.route('**/__local-model/soul', route => route.fulfill({ json: { soul: 'Synthetic test role.' } }));
    await page.route('**/__local-model/models', route => route.fulfill({ json: {
      models: [{ name: 'digitsflow/bonsai-8b:latest', parameterSize: '8B' }, { name: 'bonsai-2:latest', parameterSize: '2B' }],
      cloudModels: [],
    }}));
    await page.route('**/__local-model/chat', async route => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({ json: { message: 'Front-page chat test reply.' } });
    });
    await page.addInitScript(() => localStorage.setItem('localpilot.activeOllamaModel', 'digitsflow/bonsai-8b:latest'));
    await page.goto(process.env.LOCALPILOT_TEST_URL || 'http://localhost:4198');
    assert.equal(await page.getByRole('combobox').count(), 1, 'Front page has exactly one model selector');
    assert.equal(await page.locator('.model-card').count(), 0, 'Legacy model card is removed');
    assert.equal(await page.getByRole('button', { name: 'Configure model →', exact: true }).count(), 0);
    const picker = page.locator('#local-model-choice');
    await picker.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#local-model-choice')?.value === 'digitsflow/bonsai-8b:latest' && !document.querySelector('#local-model-choice')?.disabled);
    assert.equal(await page.locator('.local-chat-card').count(), 1);
    await page.getByRole('textbox', { name: 'Message local model' }).fill('Test the front-page chat.');
    await page.getByRole('button', { name: 'Send ↗', exact: true }).click();
    await page.getByText('Front-page chat test reply.', { exact: true }).waitFor();
    assert.equal(requests[0].model, 'digitsflow/bonsai-8b:latest');
    await picker.selectOption('bonsai-2:latest');
    assert.equal(await page.getByText('Front-page chat test reply.', { exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => localStorage.getItem('localpilot.activeOllamaModel')), 'bonsai-2:latest');
    await page.getByRole('button', { name: 'Connection settings →', exact: true }).click();
    assert.equal(await page.locator('.local-chat-card').count(), 0);
    await page.getByRole('button', { name: 'Open chat & model picker →', exact: true }).click();
    assert.equal(await picker.inputValue(), 'bonsai-2:latest');
    await page.getByText('Front-page chat test reply.', { exact: true }).waitFor();
    await page.screenshot({ path: 'todo/home-chat-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'todo/home-chat-mobile.png', fullPage: true });
    const box = await picker.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 391, 'Model picker fits mobile width');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
