const { test } = require("node:test");
const assert = require("node:assert/strict");
const ts = require("typescript");
const vm = require("node:vm");
const fs = require("node:fs");
function runtime(fetch) {
  const exports = {};
  const code = ts.transpileModule(
    fs.readFileSync("src/agentic-browser.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  vm.runInNewContext(code, { exports, fetch, URL, Error, JSON });
  return exports.runAgenticBrowserWorkflow;
}
const response = (data) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
const evidence = {
  url: "https://fixture.test/",
  title: "Fixture",
  text: "Scene editor ready",
  tabId: "tab-8",
  elements: [{ ref: "e1", tag: "input", type: "text", label: "Scene" }],
};
const options = {
  model: "fixture:cloud",
  workflow: "Write an approved scene prompt",
  input: "A blue room",
  hosts: ["fixture.test"],
  targetUrl: "https://fixture.test/",
  tabId: "tab-8",
  onLog() {},
  onApproval: async () => true,
};
test("runner binds selected tab, includes workflow and observed refs, and applies only approved actions", async () => {
  const calls = [];
  let decisions = 0;
  let observed = 0;
  const run = runtime(async (url, init) => {
    const data = JSON.parse(init.body);
    calls.push(data);
    if (url.endsWith("/chat")) {
      assert.ok(
        data.messages.some((m) =>
          m.content.includes("Write an approved scene prompt"),
        ),
      );
      assert.ok(
        data.messages.some((m) => m.content.includes("OBSERVED ELEMENTS")),
      );
      return response({
        message: JSON.stringify(
          ++decisions === 1
            ? { action: "fill", ref: "e1", value: "A blue room" }
            : {
                action: "done",
                summary: "Scene field updated; review the result.",
              },
        ),
      });
    }
    if (data.action === "open-app") {
      assert.equal(data.tabId, "tab-8");
      return response(evidence);
    }
    if (data.action === "fill")
      return response({
        approvalRequired: true,
        task: { id: "approval", detail: "Fill Scene", action: "fill" },
      });
    if (data.action === "approve") return response({ result: evidence });
    return response({});
  });
  const result = await run({
    ...options,
    onEvidence() {
      observed++;
    },
  });
  assert.equal(result.status, "paused");
  assert.equal(observed, 2);
  assert.equal(calls.filter((c) => c.action === "approve").length, 1);
  assert.equal(calls.find((c) => c.action === "fill").ref, "e1");
});
test("login required stops before sending page content to model", async () => {
  let modelCalls = 0;
  const run = runtime(async (url, init) => {
    if (url.endsWith("/chat")) modelCalls++;
    const d = JSON.parse(init.body);
    return response(
      d.action === "open-app" ? { ...evidence, loginRequired: true } : {},
    );
  });
  await assert.rejects(() => run(options), /Sign-in required/);
  assert.equal(modelCalls, 0);
});
test("pause during approval prevents the approved action from executing", async () => {
  const controller = new AbortController();
  let approved = false;
  const run = runtime(async (url, init) => {
    const d = JSON.parse(init.body);
    if (url.endsWith("/chat"))
      return response({ message: '{"action":"click","ref":"e1"}' });
    if (d.action === "open-app") return response(evidence);
    if (d.action === "click")
      return response({
        approvalRequired: true,
        task: { id: "a", detail: "Click" },
      });
    if (d.action === "approve") approved = true;
    return response({});
  });
  await assert.rejects(() =>
    run({
      ...options,
      signal: controller.signal,
      onApproval: async () => {
        controller.abort();
        return true;
      },
    }),
  );
  assert.equal(approved, false);
});

const discoveryPage = {
  ...evidence,
  elements: [{ ref: "e9", tag: "a", label: "Workflows", link: {
    protocol: "https:", hostname: "fixture.test", pathname: "/workflow/", credentialsPresent: false,
  } }],
};
const discoveryOptions = { ...options, readOnlyDiscovery: true };
test('community discovery accepts only observed exact-host publisher articles', async () => {
  const host = 'community.dualup.com';
  const path = '/@videoexpress/workflows/realistic-consistent-character-ai-videos-workflow';
  for (const [hostname, pathname, suffix, observed, allowed] of [
    [host, path, '', true, true],
    [host, path, '', false, false],
    [host, '/@other/workflows/example', '', true, false],
    ['fixture.test', path, '', true, false],
    [host, path, '?action=delete', true, false],
    [host, '/@videoexpress/workflows/example/settings', '', true, false],
  ]) {
    let opened = false, decisions = 0;
    const url = 'https://' + hostname + pathname + suffix;
    const page = { ...evidence, url: 'https://' + host + '/', elements: observed ? [{ref:'a',link:{protocol:'https:',hostname,pathname,credentialsPresent:false}}] : [] };
    const run = runtime(async (endpoint, init) => {
      const data = JSON.parse(init.body);
      if (endpoint.endsWith('/chat')) return response({message:JSON.stringify(++decisions === 1 ? {action:'open',url} : {action:'done',summary:'Visible workflow article reviewed.'})});
      if (data.action === 'open') { opened = true; return response({...page,url}); }
      return response(data.action === 'inspect' ? page : {});
    });
    const opts = {...discoveryOptions,hosts:[host,'fixture.test'],targetUrl:'https://' + host + '/'};
    if (allowed) await run(opts); else await assert.rejects(() => run(opts), /blocked navigation/i);
    assert.equal(opened, allowed);
  }
});
test("runner refuses invalid initial evidence before model transmission", async () => {
  for (const patch of [{ tabId: undefined }, { tabId: "tab-99" }, { url: "" },
    { url: "https://user:pass@fixture.test/" }, { text: "  " }]) {
    let modelCalls = 0;
    const run = runtime(async (url, init) => {
      if (url.endsWith("/chat")) modelCalls++;
      const data = JSON.parse(init.body);
      return response(data.action === "open-app" ? { ...evidence, ...patch } : {});
    });
    await assert.rejects(() => run(options), /tab binding|valid page URL|credential-free|visible text/);
    assert.equal(modelCalls, 0);
  }
});
test("runner stops when action evidence switches tabs", async () => {
  let modelCalls = 0;
  const run = runtime(async (url, init) => {
    const data = JSON.parse(init.body);
    if (url.endsWith("/chat")) {
      modelCalls++;
      return response({ message: '{"action":"inspect"}' });
    }
    return response(data.action === "open-app" ? evidence
      : data.action === "inspect" ? { ...evidence, tabId: "tab-99" } : {});
  });
  await assert.rejects(() => run(options), /tab binding/);
  assert.equal(modelCalls, 1);
});
test("credential-bearing targets and model navigation never reach worker", async () => {
  let calls = 0;
  const run = runtime(async () => { calls++; return response({}); });
  await assert.rejects(() => run({ ...options, targetUrl: "https://user:pass@fixture.test/" }), /Target URL/);
  assert.equal(calls, 0);
  let opened = false;
  const navigate = runtime(async (url, init) => {
    const data = JSON.parse(init.body);
    if (data.action === "open") opened = true;
    return response(url.endsWith("/chat")
      ? { message: '{"action":"open","url":"https://user:pass@fixture.test/"}' }
      : data.action === "open-app" ? evidence : {});
  });
  await assert.rejects(() => navigate(options), /Blocked navigation/);
  assert.equal(opened, false);
});
test("discovery requires explicit tab before transport", async () => {
  let calls = 0;
  const run = runtime(async () => { calls++; return response({}); });
  await assert.rejects(() => run({ ...discoveryOptions, tabId: undefined }), /explicitly bound/);
  assert.equal(calls, 0);
});
test("discovery forwards workload and binds observed documentation navigation", async () => {
  const calls = []; let decisions = 0;
  const run = runtime(async (url, init) => {
    const data = JSON.parse(init.body); calls.push(data);
    if (url.endsWith("/chat")) {
      assert.equal(data.model, options.model);
      assert.ok(data.messages.some(m => m.content.includes(options.workflow)));
      return response({ message: JSON.stringify(++decisions === 1
        ? { action: "open", url: "https://fixture.test/workflow/" }
        : { action: "done", summary: "Documentation visible for review." }) });
    }
    if (["inspect", "open"].includes(data.action)) {
      assert.equal(data.tabId, "tab-8");
      return response({ ...discoveryPage, ...(data.action === "open" ? { url: data.url } : {}) });
    }
    return response({});
  });
  const result = await run(discoveryOptions);
  assert.equal(result.status, "paused");
  assert.equal(calls.filter(c => c.action === "open").length, 1);
  assert.ok(!calls.some(c => ["click", "fill", "approve", "open-app"].includes(c.action)));
});
test("discovery blocks click and fill before worker or approval dispatch", async () => {
  for (const action of ["click", "fill"]) {
    const calls = []; let approvals = 0;
    const run = runtime(async (url, init) => {
      const data = JSON.parse(init.body); calls.push(data);
      return response(url.endsWith("/chat")
        ? { message: JSON.stringify({ action, ref: "e9", value: "blocked" }) }
        : data.action === "inspect" ? discoveryPage : {});
    });
    await assert.rejects(() => run({ ...discoveryOptions,
      onApproval: async () => { approvals++; return true; },
    }), /Read-only discovery blocked/);
    assert.equal(approvals, 0);
    assert.ok(!calls.some(c => ["click", "fill", "approve"].includes(c.action)));
  }
});
test("discovery rejects guessed, query, credential, outside-host and non-documentation URLs", async () => {
  for (const url of ["https://fixture.test/workflow/guessed", "https://fixture.test/workflow/?token=x",
    "https://user:pass@fixture.test/workflow/", "https://fixture.test/settings", "https://outside.test/workflow/"]) {
    let opened = false;
    const run = runtime(async (endpoint, init) => {
      const data = JSON.parse(init.body);
      if (data.action === "open") opened = true;
      return response(endpoint.endsWith("/chat")
        ? { message: JSON.stringify({ action: "open", url }) }
        : data.action === "inspect" ? discoveryPage : {});
    });
    await assert.rejects(() => run(discoveryOptions), /blocked navigation|Blocked navigation/i);
    assert.equal(opened, false);
  }
});

