const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { chromium } = require("playwright");

test("persistent browser: tab reuse, evidence, approval execution, sensitive fields and profile restart", async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "localpilot-test-"));
  let handler, browserContext;
  const links = '<a href="https://outside.test/workflows?private=hidden#hidden">Workflows</a><a href="javascript:void(0)">Script link</a><a href="https://user:pass@outside.test/private">Credential link</a>';
  const html = links +
    '<title>Workflow fixture</title><h1>Test application</h1><input aria-label="Scene prompt"><button onclick="document.querySelector(\'h1\').textContent=\'Generation approved\'">Generate preview</button><input type="password" aria-label="Password" style="display:none">';
  const sandbox = {
    __dirname,
    console: { log() {} },
    URL,
    setTimeout,
    process: { env: {}, on() {} },
    require: (name) =>
      name === "playwright"
        ? {
            chromium: {
              launchPersistentContext: async (_, options) => {
                browserContext = await chromium.launchPersistentContext(
                  profile,
                  { ...options, headless: true },
                );
                await browserContext.route("https://fixture.test/**", (route) =>
                  route.fulfill({ contentType: "text/html", body: html }),
                );
                return browserContext;
              },
            },
          }
        : name === "node:http"
          ? {
              createServer: (fn) => {
                handler = fn;
                return { listen() {} };
              },
            }
          : require(name),
  };
  vm.runInNewContext(
    await fs.readFile(path.join(__dirname, "browser-worker.cjs"), "utf8"),
    sandbox,
  );
  const call = async (action, fields = {}, expected = 200) => {
    const req = Readable.from([JSON.stringify({ action, ...fields })]);
    Object.assign(req, {
      method: "POST",
      url: "/workflow",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    });
    let code, body;
    await handler(req, {
      writeHead(status) {
        code = status;
      },
      end(raw) {
        body = JSON.parse(raw);
      },
    });
    assert.equal(code, expected, JSON.stringify(body));
    return body;
  };
  try {
    await call("allow-host", { host: "fixture.test" });
    const first = await call("open-app", { url: "https://fixture.test/" });
    const again = await call("open-app", { url: "https://fixture.test/" });
    assert.equal(first.tabId, again.tabId);
    assert.equal(first.loginRequired, false);
    const workflowLink = again.elements.find((el) => el.label === "Workflows");
    assert.equal(workflowLink.link.hostname, "outside.test");
    assert.equal(workflowLink.link.pathname, "/workflows");
    assert.ok(!JSON.stringify(workflowLink).includes("hidden"));
    const scriptLink = again.elements.find((el) => el.label === "Script link");
    assert.equal(scriptLink.link.protocol, "javascript:");
    assert.ok(!JSON.stringify(scriptLink).includes("void"));
    const credentialLink = again.elements.find((el) => el.label === "Credential link");
    assert.equal(credentialLink.link.credentialsPresent, true);
    assert.equal(credentialLink.link.pathname, undefined);
    assert.ok(!JSON.stringify(credentialLink.link).includes("pass"));
    await call("click", { tabId: first.tabId, ref: workflowLink.ref }, 400);
    await call("click", { tabId: first.tabId, ref: scriptLink.ref }, 400);
    await call("click", { tabId: first.tabId, ref: credentialLink.ref }, 400);
    assert.ok(first.elements.some((el) => el.label === "Scene prompt"));
    assert.ok(!first.elements.some((el) => /password/i.test(el.label)));
    const input = again.elements.find((el) => el.label === "Scene prompt");
    const pending = await call("fill", {
      tabId: first.tabId,
      ref: input.ref,
      value: "Test scene",
    });
    assert.equal(pending.approvalRequired, true);
    assert.equal(
      await browserContext
        .pages()
        .find((p) => p.url().startsWith("https://fixture.test"))
        .locator("input")
        .first()
        .inputValue(),
      "",
    );
    await call("approve", { id: pending.task.id });
    assert.equal(
      await browserContext
        .pages()
        .find((p) => p.url().startsWith("https://fixture.test"))
        .locator("input")
        .first()
        .inputValue(),
      "Test scene",
    );
    const evidence = await call("inspect", { tabId: first.tabId });
    const button = evidence.elements.find(
      (el) => el.label === "Generate preview",
    );
    const click = await call("click", { tabId: first.tabId, ref: button.ref });
    const approved = await call("approve", { id: click.task.id });
    assert.match(approved.result.text, /Generation approved/);
    await call(
      "fill",
      { tabId: first.tabId, selector: "[type=password]", value: "blocked" },
      400,
    );
    const active = browserContext
      .pages()
      .find((p) => p.url().startsWith("https://fixture.test"));
    await active.evaluate(() => {
      document.cookie =
        "localpilot_test=persisted; Max-Age=3600; SameSite=Lax; Secure";
    });
    await call("close");
    const reopened = await call("open-app", { url: "https://fixture.test/" });
    const restored = browserContext
      .pages()
      .find((p) => p.url().startsWith("https://fixture.test"));
    assert.match(
      await restored.evaluate(() => document.cookie),
      /localpilot_test=persisted/,
    );
    await call("inspect", { tabId: "missing-tab" }, 400);
    assert.ok(reopened.tabId);
    await restored.locator("[type=password]").evaluate((el) => {
      el.style.display = "block";
    });
    const login = await call("inspect", { tabId: reopened.tabId });
    assert.equal(login.loginRequired, true);
    assert.deepEqual(login.elements, []);
  } finally {
    await call("close").catch(() => {});
    await fs.rm(profile, { recursive: true, force: true });
  }
});
