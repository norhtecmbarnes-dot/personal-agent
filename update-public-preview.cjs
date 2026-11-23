const fs = require('node:fs');
const p = 'src/App.tsx';
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf("        {tab === 'Browser profiles'");
const end = s.indexOf("        {tab === 'Settings'", start);
if (start < 0 || end < 0) throw Error('Section missing');
s = s.slice(0, start) + `        {tab === 'Browser profiles' && <><section className="page-heading"><div><div className="eyebrow">CONFIGURATION</div><h1>Browser profiles</h1><p className="subtitle">An isolated Chromium profile, managed by the local browser worker.</p></div></section><div className="browser-demo-notice"><strong>{localRuntime ? 'Browser worker connection has not been checked on this page.' : 'Browser automation is available only in the local app.'}</strong><p>The local installation includes a Playwright browser worker and a persistent, isolated Chromium profile. The public gallery cannot launch that worker or access browsers and local services on your computer. It does not attach to your everyday browser or import its cookies. Sign in directly in the isolated browser; never paste passwords or cookies here.</p><button className="secondary-button" onClick={() => setTab('Workflows')}>Open workflow setup →</button></div><div className="settings-card workflow-empty"><div className="empty-icon">◉</div><h2>{localRuntime ? 'Use the local workflow browser' : 'Open Personal Agent on your computer'}</h2><p>In the local app, open Workflows to start the browser, sign in manually, and explicitly select the intended tab. Review the brief and approve consequential actions before execution. A saved profile or an existing worker does not by itself mean a workflow is connected or verified.</p><span className="disconnected-pill">{localRuntime ? 'WORKER STATUS NOT CHECKED' : 'PUBLIC PREVIEW · LOCAL RUNTIME REQUIRED'}</span></div></>}
` + s.slice(end);
s = s.replace('This prototype has no browser worker. Approving records your review only and cannot run tasks. Sample requests are labeled.', 'This review queue does not execute workflows. The local browser worker is managed separately from Workflows. Approving here records your review only. Sample requests are labeled.');
s = s.replace('Approval records review only. A real execution broker and a separate execution step do not exist in this prototype.', 'Approval here records review only. Browser execution is a separate flow in the local Workflows page, with its own connection, tab binding, and approval requirements.');
fs.writeFileSync(p, s);
const t = 'public-preview.test.cjs';
let tests = fs.readFileSync(t, 'utf8');
tests = tests.replace("await page.getByRole('button', { name: 'Settings', exact: true }).click();", `await page.locator('.nav-item').filter({ hasText: 'Browser profiles' }).click();
      await page.getByRole('heading', { name: 'Open Personal Agent on your computer', exact: true }).waitFor();
      assert.doesNotMatch(await page.locator('body').innerText(), /not been implemented|no browser worker|DEMO · NOT CONFIGURED/);
      await page.locator('.nav-item').filter({ hasText: 'Settings' }).click();`);
fs.writeFileSync(t, tests);
