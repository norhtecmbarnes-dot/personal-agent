const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const base = process.env.LOCALPILOT_TEST_URL || 'http://localhost:4198';
const live = process.env.LOCALPILOT_LIVE_MODEL_TEST === '1';
const model = process.env.LOCALPILOT_TEST_MODEL || 'abliterant/qwen3.8-rana:latest';
test('clarification UI uses selected local model, preserves draft on cancellation, and never approves', { timeout: 210000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const requests = [];
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/__local-model/')) requests.push({ path: new URL(r.url()).pathname, body: r.postDataJSON() }); });
    if (!live) {
      await page.route('**/__local-model/models', r => r.fulfill({ json: { models: [{ name: model }] } }));
      await page.route('**/__local-model/workflows', r => r.fulfill({ json: { workflows: [{ id: 'fixture', title: 'Consistent Character Producer', state: 'draft', domains: 'app.videoexpress.ai', targetUrl: 'https://app.videoexpress.ai/' }] } }));
      await page.route('**/__local-model/browser-health', r => r.fulfill({ json: { running: false } }));
      let calls = 0;
      await page.route('**/__local-model/chat', async r => {
        if (++calls === 1) await r.fulfill({ json: { message: 'DRAFT fixture: UNSPECIFIED', elapsedMs: 1200 } });
        else await new Promise(resolve => setTimeout(resolve, 3000)).then(() => r.abort().catch(() => {}));
      });
    }
    const before = live ? await fetch(base + '/__local-model/workflows').then(r => r.json()) : null;
    await page.goto(base);
    await page.getByRole('button').filter({ hasText: /Workflows/ }).first().click();
    await page.waitForFunction(selected => document.querySelector('#wf-select')?.options.length > 1 && Array.from(document.querySelectorAll('select option')).some(o => o.value === selected), model);
    const value = await page.locator('#wf-select option').evaluateAll(es => es.find(e => e.textContent.includes('Consistent Character Producer'))?.value);
    await page.locator('#wf-select').selectOption(value);
    await page.locator('select').filter({ has: page.locator('option', { hasText: model }) }).selectOption(model);
    await page.getByLabel('TASK / CHARACTER BRIEF', { exact: true }).fill("Prepare an UNAPPROVED draft about Abraham Lincoln on the final day of his life, with five chronological scene directions. Supplied identity: Abraham Lincoln. Unprovided visual details, props, scene events, style, and appearance remain UNSPECIFIED unless explicitly labeled PROPOSAL for my review. Do not browse, generate media, or approve anything. Ask only essential unanswered questions, or produce a concise DRAFT for review.");
    const responsePromise = page.waitForResponse(r => r.url().endsWith('/__local-model/chat') && r.request().method() === 'POST', { timeout: 185000 });
    await page.getByRole('button', { name: 'Clarify my brief with the model', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel clarification', exact: true }).waitFor();
    const response = await responsePromise;
    const payload = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(payload));
    assert.ok(payload.message.length > 20);
    if (live) { assert.equal(payload.model, model); assert.equal(payload.inference, 'local'); }
    await page.getByRole('button', { name: 'Send answer / continue with model', exact: true }).waitFor();
    const draft = await page.locator('.wf-result').filter({ hasText: payload.message.slice(0, 25) }).first().innerText();
    assert.ok(draft.includes(payload.message));
    assert.equal(await page.getByLabel('EDIT THE CANONICAL BRIEF BEFORE APPROVING', { exact: true }).inputValue(), '');
    if (!live) {
      await page.getByRole('button', { name: 'Send answer / continue with model', exact: true }).click();
      await page.getByRole('button', { name: 'Cancel clarification', exact: true }).click();
      await page.getByText('Clarification cancelled. Previous draft preserved; nothing approved.', { exact: true }).waitFor();
      assert.equal(await page.locator('.wf-result').filter({ hasText: 'DRAFT fixture' }).first().innerText(), draft);
    }
    assert.equal(requests.filter(r => r.path !== '/__local-model/chat').length, 0, 'No workflow writes or browser actions');
    assert.equal(requests[0].body.model, model);
    assert.equal(requests[0].body.purpose, 'workflow-clarification');
    assert.ok(requests[0].body.messages[1].content.includes('WORKLOAD MARKDOWN:'));
    assert.equal(errors.length, 0, errors.join('\n'));
    if (live) {
      const after = await fetch(base + '/__local-model/workflows').then(r => r.json());
      assert.deepEqual(after, before, 'Saved workflow is unchanged');
      fs.mkdirSync('.localpilot', { recursive: true });
      fs.writeFileSync('.localpilot/clarification-verification.json', JSON.stringify({ verifiedAt: new Date().toISOString(), model, inference: payload.inference, elapsedMs: payload.elapsedMs, truncated: payload.truncated, metrics: payload.metrics, workloadChars: requests[0].body.messages[1].content.length, draft, workflowUnchanged: true, browserActions: 0, approvals: 0 }, null, 2));
      await page.screenshot({ path: '.localpilot/clarification-verification.png', fullPage: true });
      console.log(JSON.stringify({ model, elapsedMs: payload.elapsedMs, truncated: payload.truncated, draftChars: draft.length, metrics: payload.metrics }));
    }
  } finally { await browser.close(); }
});
