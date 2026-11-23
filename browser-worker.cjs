const { chromium } = require("playwright");
const { mkdir } = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

const HOST = "127.0.0.1";
const PORT = Number(process.env.LOCALPILOT_BROWSER_PORT || 4201);
const PROFILE = path.join(__dirname, ".localpilot", "browser-profile");
const allowedHosts = new Set();
const approvals = new Map();
const tabIds = new WeakMap();
let context, page, starting;
let sequence = 0;
const livePages = () =>
  context ? context.pages().filter((p) => !p.isClosed()) : [];
const tabId = (p) => {
  if (!p || p.isClosed()) return "";
  if (!tabIds.has(p)) tabIds.set(p, `tab-${++sequence}`);
  return tabIds.get(p);
};
const describe = async (p) => ({
  id: tabId(p),
  url: p.url(),
  title: await p.title().catch(() => ""),
});
const tabs = () => Promise.all(livePages().map(describe));
const focus = (p) => {
  if (!p || p.isClosed())
    throw Error(
      "Selected tab is closed. Open the application again or select another tab.",
    );
  page = p;
  return p;
};
const byId = (id) => livePages().find((p) => tabId(p) === id);
const assertAllowed = (p) => {
  const u = new URL(p.url());
  if (
    !["http:", "https:"].includes(u.protocol) ||
    !allowedHosts.has(u.hostname.toLowerCase())
  )
    throw Error(
      `Page is outside the workflow allowlist: ${u.hostname || u.protocol}. Complete sign-in manually, then return to the application.`,
    );
};
const safeUrl = (value) => {
  const u = new URL(value);
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    !allowedHosts.has(u.hostname.toLowerCase())
  )
    throw Error(
      "URL must use http(s), contain no credentials, and match an allowed hostname.",
    );
  return u;
};
async function ensureBrowser() {
  if (context) {
    page =
      page && !page.isClosed()
        ? page
        : livePages().at(-1) || (await context.newPage());
    return;
  }
  if (starting) return starting;
  starting = (async () => {
    await mkdir(PROFILE, { recursive: true });
    const launched = await chromium.launchPersistentContext(PROFILE, {
      headless: false,
      viewport: { width: 1365, height: 900 },
      args: ["--no-first-run"],
    });
    context = launched;
    const track = (p) => {
      tabId(p);
      p.on("close", () => {
        if (page === p) page = livePages().at(-1);
      });
    };
    launched.pages().forEach(track);
    launched.on("page", track);
    launched.on("close", () => {
      if (context === launched) {
        context = undefined;
        page = undefined;
        approvals.clear();
      }
    });
    page = launched.pages()[0] || (await launched.newPage());
  })();
  try {
    await starting;
  } finally {
    starting = undefined;
  }
}
async function snapshot(p) {
  assertAllowed(p);
  await p
    .waitForLoadState("domcontentloaded", { timeout: 10000 })
    .catch(() => {});
  await p.locator("body").waitFor({ state: "attached", timeout: 12000 });
  const observed = await p.evaluate(() => {
    const sensitive =
      /password|passwd|otp|one.?time|token|secret|credit|card.?number|cvv|verification.?code/i;
    const visible = (el) =>
      !!(
        el.getClientRects().length &&
        getComputedStyle(el).visibility !== "hidden"
      );
    const loginRequired =
      [...document.querySelectorAll('input[type="password"]')].some(visible) ||
      /\/(login|signin|sign-in|auth)(\/|\?|$)/i.test(location.pathname);
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    const parts = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (
        parent &&
        visible(parent) &&
        !parent.closest("script,style,input,textarea,[contenteditable]")
      )
        parts.push(node.textContent);
    }
    const text = parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 12000);
    const elements = [];
    let index = 0;
    for (const el of document.querySelectorAll(
      'button,a[href],input,textarea,select,[role="button"],[contenteditable="true"]',
    )) {
      el.removeAttribute("data-localpilot-ref");
      if (
        !visible(el) ||
        el.disabled ||
        el.type === "hidden" ||
        el.type === "file" ||
        sensitive.test(
          [
            el.type,
            el.name,
            el.id,
            el.getAttribute("autocomplete"),
            el.getAttribute("aria-label"),
            el.getAttribute("placeholder"),
          ].join(" "),
        )
      )
        continue;
      if (elements.length >= 100) continue;
      const ref = `e${++index}`;
      el.setAttribute("data-localpilot-ref", ref);
      // Expose navigation evidence without leaking query tokens, fragments,
      // embedded credentials, or executable non-HTTP link payloads.
      let link;
      if (el.tagName === "A") {
        try {
          const destination = new URL(el.getAttribute("href"), location.href);
          const http = ["http:", "https:"].includes(destination.protocol);
          link = {
            protocol: destination.protocol,
            hostname: http ? destination.hostname : undefined,
            pathname: http && !destination.username && !destination.password
              ? destination.pathname.slice(0, 500)
              : undefined,
            credentialsPresent: !!(destination.username || destination.password),
          };
        } catch {
          link = { invalid: true };
        }
      }
      elements.push({
        ref,
        link,
        value: ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)
          ? String(el.value || "").slice(0, 3000)
          : undefined,
        tag: el.tagName.toLowerCase(),
        type: el.type || "",
        label: (
          el.getAttribute("aria-label") ||
          el.getAttribute("placeholder") ||
          el.innerText ||
          el.name ||
          ""
        )
          .trim()
          .slice(0, 180),
      });
    }
    return {
      text: loginRequired
        ? "Sign-in page detected. Complete sign-in manually in Chromium; credentials are never sent to the model."
        : text,
      elements: loginRequired ? [] : elements,
      loginRequired,
    };
  });
  return {
    ...observed,
    url: p.url(),
    title: await p.title(),
    tabId: tabId(p),
    tabs: await tabs(),
    persistentSession: true,
  };
}
async function target(data) {
  await ensureBrowser();
  return data.tabId ? focus(byId(String(data.tabId))) : focus(page);
}
const forbidden =
  /password|passwd|otp|one.?time|token|secret|credit|card.?number|cvv|verification.?code|log.?in|sign.?in|sign.?out|log.?out|checkout|purchase|payment|billing|subscription|delete|revoke|reset.?password/i;
async function prepareAction(p, action, data) {
  assertAllowed(p);
  const selector = data.ref
    ? `[data-localpilot-ref="${String(data.ref).replace(/[^a-z0-9]/gi, "")}"]`
    : String(data.selector || "");
  if (!selector || selector.length > 500)
    throw Error("Choose an observed element reference.");
  const locator = p.locator(selector);
  if ((await locator.count()) !== 1)
    throw Error("Element changed or is ambiguous. Inspect the page again.");
  await locator.waitFor({ state: "visible", timeout: 10000 });
  const meta = await locator.evaluate((el) => ({
    tag: el.tagName,
    type: el.getAttribute("type") || "",
    label: [
      el.innerText,
      el.getAttribute("aria-label"),
      el.getAttribute("name"),
      el.id,
      el.getAttribute("autocomplete"),
      el.getAttribute("placeholder"),
    ]
      .filter(Boolean)
      .join(" ")
      .trim()
      .slice(0, 500),
    href: el.getAttribute("href"),
    form: !!el.closest("form"),
  }));
  if (forbidden.test(`${meta.type} ${meta.label}`) || meta.type === "file")
    throw Error(
      "Authentication, secrets, uploads, payments, and destructive controls must be handled manually in Chromium.",
    );
  if (action === "click" && meta.href)
    safeUrl(new URL(meta.href, p.url()).href);
  if (
    action === "fill" &&
    (typeof data.value !== "string" || data.value.length > 5000)
  )
    throw Error("Text must be non-secret and at most 5,000 characters.");
  return { locator, meta };
}
async function perform(action, data) {
  if (action === "status")
    return {
      running: !!context,
      tabId: tabId(page),
      tabs: await tabs(),
      persistentSession: true,
    };
  if (action === "allow-host") {
    const host = String(data.host || "")
      .trim()
      .toLowerCase();
    if (
      !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
        host,
      )
    )
      throw Error("Enter a hostname only.");
    allowedHosts.add(host);
    return { allowedHosts: [...allowedHosts] };
  }
  if (action === "launch") {
    await ensureBrowser();
    await page.bringToFront();
    return {
      running: true,
      tabId: tabId(page),
      tabs: await tabs(),
      persistentSession: true,
    };
  }
  if (action === "tabs") {
    await ensureBrowser();
    return { tabs: await tabs(), activeTabId: tabId(page) };
  }
  if (action === "select-tab") {
    const p = await target(data);
    await p.bringToFront();
    return {
      ...(await describe(p)),
      tabId: tabId(p),
      activeTabId: tabId(p),
      tabs: await tabs(),
    };
  }
  if (action === "open" || action === "open-app") {
    const url = safeUrl(String(data.url || ""));
    await ensureBrowser();
    let p;
    if (data.tabId) p = byId(String(data.tabId));
    else if (action === "open-app")
      p = livePages().find((p) => {
        try {
          return new URL(p.url()).origin === url.origin;
        } catch {
          return false;
        }
      });
    if (data.tabId && !p)
      throw Error("Selected tab was closed. Select an open application tab.");
    if (p && action === "open-app" && new URL(p.url()).origin !== url.origin)
      throw Error(
        "Selected tab belongs to another application. Select the correct tab or reopen the target.",
      );
    const reuse = !!p && action === "open-app";
    p = focus(
      p ||
        (data.newTab || action === "open-app" ? await context.newPage() : page),
    );
    await p.bringToFront();
    if (!reuse)
      await p.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30000 });
    // OAuth redirects may leave the approved hostname. Do not read those pages.
    try {
      assertAllowed(p);
    } catch {
      return {
        url: p.url(),
        title: "Manual sign-in required",
        tabId: tabId(p),
        tabs: await tabs(),
        text: "Complete sign-in manually, then check the session.",
        elements: [],
        loginRequired: true,
        persistentSession: true,
      };
    }
    await p.waitForTimeout(500);
    return snapshot(p);
  }
  if (action === "inspect") return snapshot(await target(data));
  if (action === "select") {
    const p = await target(data);
    const ref = String(data.ref || "");
    const value = String(data.value || "");
    if (!ref || !value) throw Error("select requires ref and value.");
    const task = {
      id: crypto.randomUUID(),
      action,
      detail: `Select "${value}" in dropdown ${ref} in ${tabId(p)}`,
      createdAt: new Date().toISOString(),
    };
    approvals.set(task.id, {
      task,
      p,
      url: p.url(),
      action,
      data: { ...data },
      fingerprint: JSON.stringify({ ref, value }),
    });
    return { approvalRequired: true, task };
  }
  if (action === "eval") {
    if (process.env.LOCALPILOT_EVAL !== "1")
      throw Error("eval is disabled. Restart the worker with LOCALPILOT_EVAL=1 to enable arbitrary page JS (debug only).");
    const p = await target(data);
    const fn = String(data.script || "");
    if (!fn) throw Error("eval requires script.");
    const result = await p.evaluate(`(() => { ${fn} })()`);
    return { ok: true, result };
  }
  if (action === "atpoint") {
    const p = await target(data);
    const info = await p.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const chain = [];
      let cur = el;
      for (let i = 0; i < 4 && cur; i++) {
        chain.push({
          tag: cur.tagName,
          id: cur.id || "",
          cls: (cur.className || "").toString().slice(0, 80),
          text: (cur.innerText || "").slice(0, 80),
          role: cur.getAttribute ? cur.getAttribute("role") : null,
        });
        cur = cur.parentElement;
      }
      return chain;
    }, [Number(data.x), Number(data.y)]);
    return { ok: true, at: [data.x, data.y], chain: info };
  }
  if (action === "screenshot") {
    const p = await target(data);
    const dir = path.join(__dirname, ".localpilot");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `shot-${Date.now()}.png`);
    await p.screenshot({ path: file });
    return { ok: true, path: file, tabId: tabId(p), url: p.url() };
  }
  if (action === "clickAt") {
    const p = await target(data);
    const x = Number(data.x), y = Number(data.y);
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw Error("clickAt requires numeric x and y.");
    const btnLabel = data.button === "right" ? "Right-click" : data.button === "middle" ? "Middle-click" : "Click";
    const task = {
      id: crypto.randomUUID(),
      action,
      detail: `${btnLabel} at (${Math.round(x)},${Math.round(y)}) in ${tabId(p)}
This may change the application or consume generation credits.`,
      createdAt: new Date().toISOString(),
    };
    approvals.set(task.id, {
      task,
      p,
      url: p.url(),
      action,
      data: { x, y, button: data.button === "right" || data.button === "middle" ? data.button : "left" },
      fingerprint: JSON.stringify({ x, y, button: data.button }),
    });
    return { approvalRequired: true, task };
  }
  if (action === "drag") {
    const p = await target(data);
    const x1 = Number(data.fromX), y1 = Number(data.fromY);
    const x2 = Number(data.toX), y2 = Number(data.toY);
    if (![x1, y1, x2, y2].every(Number.isFinite))
      throw Error("drag requires numeric fromX/fromY/toX/toY.");
    const task = {
      id: crypto.randomUUID(),
      action,
      detail: `Drag from (${Math.round(x1)},${Math.round(y1)}) to (${Math.round(x2)},${Math.round(y2)}) in ${tabId(p)}\nThis may change the application or add media to a timeline.`,
      createdAt: new Date().toISOString(),
    };
    approvals.set(task.id, {
      task,
      p,
      url: p.url(),
      action,
      data: { x1, y1, x2, y2 },
      fingerprint: JSON.stringify({ x1, y1, x2, y2 }),
    });
    return { approvalRequired: true, task };
  }
  if (action === "fill" || action === "click") {
    const p = await target(data);
    const { meta } = await prepareAction(p, action, data);
    const task = {
      id: crypto.randomUUID(),
      action,
      detail: `${action === "fill" ? "Fill" : "Click"} “${meta.label || meta.tag}” in ${tabId(p)}${action === "fill" ? `\nProposed text: ${data.value}` : "\nThis may change the application or consume generation credits."}`,
      createdAt: new Date().toISOString(),
    };
    approvals.set(task.id, {
      task,
      p,
      url: p.url(),
      action,
      data: { ...data },
      fingerprint: JSON.stringify(meta),
    });
    return { approvalRequired: true, task };
  }
  if (action === "approve" || action === "reject") {
    const pending = approvals.get(String(data.id || ""));
    if (!pending) throw Error("Approval expired or already handled.");
    approvals.delete(pending.task.id);
    if (action === "reject") return { rejected: true };
    if (Date.now() - Date.parse(pending.task.createdAt) > 300000)
      throw Error("Approval expired. Inspect the page again.");
    const p = focus(pending.p);
    if (p.url() !== pending.url)
      throw Error(
        "Page changed while waiting for approval. Inspect before retrying.",
      );
    if (pending.action === "select") {
      if (p.url() !== pending.url)
        throw Error("Page changed while waiting for approval. Inspect before retrying.");
      const el = p.locator(`[data-localpilot-ref="${pending.data.ref}"]`);
      if (!(await el.count()))
        throw Error("Select target no longer present. Inspect the page again.");
      await el.selectOption(String(pending.data.value));
      await p.waitForTimeout(300);
      return { approved: true, result: await snapshot(p) };
    }
    if (pending.action === "clickAt") {
      await p.bringToFront();
      const btn = pending.data.button === "right" ? "right" : pending.data.button === "middle" ? "middle" : "left";
      await p.mouse.click(pending.data.x, pending.data.y, { button: btn });
      await p.waitForTimeout(500);
      return { approved: true, result: await snapshot(p) };
    }
    if (pending.action === "drag") {
      await p.bringToFront();
      await p.mouse.move(pending.data.x1, pending.data.y1);
      await p.mouse.down();
      await p.mouse.move(pending.data.x2, pending.data.y2, { steps: 20 });
      await p.mouse.up();
      await p.waitForTimeout(700);
      return { approved: true, result: await snapshot(p) };
    }
    const { locator, meta } = await prepareAction(
      p,
      pending.action,
      pending.data,
    );
    if (JSON.stringify(meta) !== pending.fingerprint)
      throw Error(
        "Element changed while waiting for approval. Inspect before retrying.",
      );
    await p.bringToFront();
    if (pending.action === "fill")
      await locator.fill(pending.data.value, { timeout: 10000 });
    else await locator.click({ timeout: 10000 });
    await p.waitForTimeout(500);
    return { approved: true, result: await snapshot(p) };
  }
  if (action === "close") {
    if (context) await context.close();
    return { closed: true };
  }
  throw Error("Unknown browser action.");
}
const send = (res, status, data) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
};
http
  .createServer(async (req, res) => {
    if (
      !["127.0.0.1", "::1"].includes(
        (req.socket.remoteAddress || "").replace(/^::ffff:/, ""),
      )
    )
      return send(res, 403, { error: "Local device only." });
    if (req.headers.origin)
      return send(res, 403, { error: "Use the Personal Agent bridge." });
    if (req.method === "GET" && req.url === "/health")
      return send(res, 200, {
        ok: true,
        version: 2,
        service: "Personal Agent persistent browser worker",
      });
    if (req.method !== "POST" || req.url !== "/workflow")
      return send(res, 404, { error: "Not found." });
    try {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 100000) throw Error("Request too large.");
      }
      const data = JSON.parse(raw || "{}");
      return send(res, 200, await perform(String(data.action || ""), data));
    } catch (error) {
      return send(res, 400, {
        error: error.message || "Browser action failed.",
      });
    }
  })
  .listen(PORT, HOST, () =>
    console.log(
      `Personal Agent browser worker listening at http://${HOST}:${PORT}`,
    ),
  );
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (context) await context.close().catch(() => {});
    process.exit(0);
  });
