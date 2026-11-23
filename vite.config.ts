import { defineConfig, type Plugin } from "vite";
import { requestLocalChat, requestProviderChat } from "./local-model-chat";
import react from "@vitejs/plugin-react";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { discoverWorkflowGuides, type DiscoveryWorkflow } from "./src/guide-discovery";
let discoveryRunning = false;
import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
  scryptSync,
} from "node:crypto";
import https from "node:https";

const OLLAMA = "http://127.0.0.1:11434";
const VAULT_DIR = join(process.cwd(), ".localpilot");
const VAULT_PATH = join(VAULT_DIR, "credentials.enc.json");
const WORKFLOWS_PATH = join(VAULT_DIR, "workflows.json");
const BROWSER = "http://127.0.0.1:4201";
let browserWorker: import("node:child_process").ChildProcess | undefined;
let browserWorkerError = "";
let browserWorkerOutput = "";
const vaultPassword = process.env.LOCALPILOT_VAULT_PASSWORD?.trim() || "";
const VAULT_KEY = vaultPassword
  ? scryptSync(vaultPassword, "Personal Agent-local-vault-v2", 32)
  : null;
const isCloudModel = (name: string) =>
  /(?:^|:)cloud(?:$|[-])|[-:]cloud$/i.test(name.trim());
const encryptSecret = (value: string) => {
  if (!VAULT_KEY)
    throw new Error(
      "Credential vault is locked. Configure LOCALPILOT_VAULT_PASSWORD in the local environment before saving credentials.",
    );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", VAULT_KEY, iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
};
const loadVault = async (): Promise<
  Record<string, { iv: string; tag: string; data: string }>
> => {
  try {
    return JSON.parse(await readFile(VAULT_PATH, "utf8"));
  } catch {
    return {};
  }
};
const decryptSecret = (entry: {
  iv: string;
  tag: string;
  data: string;
}): string | null => {
  if (!VAULT_KEY) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      VAULT_KEY,
      Buffer.from(entry.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(entry.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
};
// Telegram secrets are stored as an encrypted JSON payload { token, chatId }.
// Legacy entries hold a raw token string (no chatId) and still decrypt.
const readTelegramCredentials = async (): Promise<{
  token: string;
  chatId?: string;
} | null> => {
  const vault = await loadVault();
  const entry = vault.telegram;
  if (!entry) return null;
  const raw = decryptSecret(entry);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { token?: string; chatId?: string };
    if (parsed && typeof parsed.token === "string" && parsed.token.trim())
      return {
        token: parsed.token.trim(),
        chatId:
          typeof parsed.chatId === "string" && parsed.chatId.trim()
            ? parsed.chatId.trim()
            : undefined,
      };
    return null;
  } catch {
    return { token: raw.trim() };
  }
};
const sendTelegramMessage = (
  token: string,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> =>
  new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, 4000),
      disable_web_page_preview: true,
    });
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${token}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 10000,
      },
      (response) => {
        let raw = "";
        response.on("data", (chunk) => (raw += chunk));
        response.on("end", () => {
          try {
            const json = JSON.parse(raw) as { ok?: boolean; description?: string };
            resolve(
              json.ok
                ? { ok: true }
                : { ok: false, error: json.description || `Telegram HTTP ${response.statusCode}` },
            );
          } catch {
            resolve({ ok: false, error: `Telegram returned HTTP ${response.statusCode}` });
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "Telegram request timed out" });
    });
    req.on("error", (error) =>
      resolve({ ok: false, error: error.message || "Telegram request failed" }),
    );
    req.write(body);
    req.end();
  });
const saveVault = async (
  vault: Record<string, { iv: string; tag: string; data: string }>,
) => {
  await mkdir(VAULT_DIR, { recursive: true });
  await writeFile(VAULT_PATH, JSON.stringify(vault), { mode: 0o600 });
};

// OpenAI-compatible API providers (user-supplied keys, stored encrypted in the vault).
// The key never leaves this process; the UI only ever sees label/baseUrl/model.
type ProviderRecord = {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
};
const readProviders = async (): Promise<ProviderRecord[]> => {
  const vault = await loadVault();
  const entry = vault.providers;
  if (!entry) return [];
  const raw = decryptSecret(entry);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p) =>
          p &&
          typeof p.id === "string" &&
          typeof p.apiKey === "string" &&
          p.apiKey,
      )
      .map((p) => ({
        id: String(p.id),
        label: String(p.label || "Provider").slice(0, 80),
        baseUrl: String(p.baseUrl || ""),
        model: String(p.model || "").slice(0, 160),
        apiKey: String(p.apiKey),
      }));
  } catch {
    return [];
  }
};
const saveProviders = async (providers: ProviderRecord[]) => {
  const vault = await loadVault();
  if (providers.length)
    vault.providers = encryptSecret(JSON.stringify(providers));
  else delete vault.providers;
  await saveVault(vault);
};
const isAllowedProviderBaseUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol)) return false;
    if (url.username || url.password) return false;
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const isLocal =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    return url.protocol === "https:" || isLocal;
  } catch {
    return false;
  }
};

const isLocalHost = (host = "") =>
  ["127.0.0.1", "localhost", "::1"].includes(
    host.split(":")[0].replace(/^\[/, "").replace(/\]$/, ""),
  );

function localModelBridge(): Plugin {
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host || "";
    if (!isLocalHost(host)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Local model bridge is only available from this device.",
        }),
      );
      return;
    }

    const url = new URL(req.url || "/", "http://localhost");
    const send = (status: number, data: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    const readBody = async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      return JSON.parse(
        Buffer.concat(chunks).toString("utf8") || "{}",
      ) as Record<string, unknown>;
    };

    try {
      if (
        (url.pathname === "/__local-model/soul" || url.pathname === "/soul") &&
        req.method === "GET"
      ) {
        try {
          return send(200, {
            soul: await readFile(join(process.cwd(), "SOUL.md"), "utf8"),
          });
        } catch {
          return send(404, {
            error:
              "SOUL.md is unavailable. Restore the Personal Agent role file and retry chat.",
          });
        }
      }
      if ((url.pathname === "/__local-model/discover-guides" || url.pathname === "/discover-guides") && req.method === "POST") {
        if (discoveryRunning) return send(409, { error: "A guide discovery run is already active." });
        const body = await readBody();
        const workflows = JSON.parse(await readFile(WORKFLOWS_PATH, "utf8")) as DiscoveryWorkflow[];
        const workflow = workflows.find((item) => item.id === body.workflowId);
        if (!workflow) return send(404, { error: "Saved workflow not found." });
        discoveryRunning = true;
        try {
          const transport: typeof fetch = (input, init) => {
            const endpoint = String(input);
            if (!["/__local-model/browser", "/__local-model/chat"].includes(endpoint)) throw Error("Discovery transport endpoint rejected.");
            return fetch(new URL(endpoint, "http://127.0.0.1:" + (req.socket.localPort || 4198)), init);
          };
          const procedure = await readFile(join(process.cwd(), "public/workloads/consistent-character-producer.md"), "utf8");
          const result = await discoverWorkflowGuides({ workflow, tabId: String(body.tabId || ""), procedure, transport });
          await mkdir(VAULT_DIR, { recursive: true });
          await writeFile(join(VAULT_DIR, "guide-discovery-latest.json"), JSON.stringify(result, null, 2));
          return send(200, result);
        } finally { discoveryRunning = false; }
      }
      if (
        (url.pathname === "/__local-model/workflows" ||
          url.pathname === "/workflows") &&
        req.method === "GET"
      ) {
        try {
          return send(200, {
            workflows: JSON.parse(await readFile(WORKFLOWS_PATH, "utf8")),
          });
        } catch {
          return send(200, { workflows: [] });
        }
      }
      if (
        (url.pathname === "/__local-model/workflows" ||
          url.pathname === "/workflows") &&
        req.method === "POST"
      ) {
        const body = await readBody();
        const action = String(body.action || "save");
        const item = body.workflow as Record<string, unknown> | undefined;
        if (action === "list") {
          try {
            return send(200, {
              workflows: JSON.parse(await readFile(WORKFLOWS_PATH, "utf8")),
            });
          } catch {
            return send(200, { workflows: [] });
          }
        }
        if (action === "delete") {
          const id = item?.id;
          if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(id))
            return send(400, {
              error: "A valid workflow id is required for deletion.",
            });
          let workflows: Record<string, unknown>[] = [];
          try {
            const stored: unknown = JSON.parse(
              await readFile(WORKFLOWS_PATH, "utf8"),
            );
            if (!Array.isArray(stored))
              return send(500, {
                error: "Saved workflow data is malformed; nothing was removed.",
              });
            workflows = stored.filter(
              (entry): entry is Record<string, unknown> =>
                !!entry && typeof entry === "object" && !Array.isArray(entry),
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
              return send(500, {
                error:
                  "Could not read saved workflow data; nothing was removed.",
              });
          }
          const remaining = workflows.filter((existing) => existing.id !== id);
          if (remaining.length === workflows.length)
            return send(404, {
              error: "Workflow not found; nothing was removed.",
            });
          await mkdir(VAULT_DIR, { recursive: true });
          const temporary = WORKFLOWS_PATH + ".tmp";
          await writeFile(temporary, JSON.stringify(remaining), {
            mode: 0o600,
          });
          await rename(temporary, WORKFLOWS_PATH);
          return send(200, { ok: true, workflows: remaining });
        }
        if (
          !item ||
          typeof item.id !== "string" ||
          !/^[a-zA-Z0-9-]{1,100}$/.test(item.id) ||
          typeof item.title !== "string" ||
          !item.title.trim() ||
          item.title.length > 200 ||
          item.instructions !== "/workloads/consistent-character-producer.md"
        ) {
          return send(400, {
            error:
              "Workflow requires a valid id, title, and bundled Producer Markdown path.",
          });
        }
        const hosts = String(item.domains || "")
          .split(/[\s,]+/)
          .map((host) => host.trim().toLowerCase())
          .filter(Boolean);
        for (const host of hosts) {
          try {
            const parsed = new URL("http://" + host);
            if (
              parsed.hostname.toLowerCase() !== host ||
              parsed.pathname !== "/" ||
              parsed.port ||
              parsed.username ||
              parsed.password
            )
              return send(400, {
                error: "Hostname allowlist must contain hostnames only.",
              });
          } catch {
            return send(400, {
              error: "Hostname allowlist contains an invalid hostname.",
            });
          }
        }
        if (
          typeof item.domains !== "string" ||
          !hosts.length ||
          item.domains.length > 3000
        )
          return send(400, { error: "A hostname allowlist is required." });
        if (typeof item.targetUrl !== "string")
          return send(400, { error: "A saved target URL is required." });
        try {
          const target = new URL(item.targetUrl);
          if (
            !["http:", "https:"].includes(target.protocol) ||
            target.username ||
            target.password ||
            !hosts.includes(target.hostname.toLowerCase())
          )
            return send(400, {
              error:
                "Target URL must use http(s) and match the saved hostname allowlist.",
            });
        } catch {
          return send(400, { error: "Target URL is invalid." });
        }
        if (
          item.procedure !== undefined &&
          (typeof item.procedure !== "string" ||
            !item.procedure.trim() ||
            item.procedure.length > 100000)
        )
          return send(400, {
            error: "Workflow Markdown must contain 1–100,000 characters.",
          });
        if (
          item.approvedBrief !== undefined &&
          (typeof item.approvedBrief !== "string" ||
            item.approvedBrief.length > 20000)
        )
          return send(400, { error: "Approved brief is invalid or too long." });
        if (
          ![
            "draft",
            "active",
            "running",
            "paused",
            "completed",
            "blocked",
            "cancelled",
          ].includes(String(item.state))
        )
          return send(400, { error: "Workflow state is invalid." });
        if (item.state !== "draft" && (!item.targetUrl || !hosts.length))
          return send(400, {
            error:
              "Only a saved workflow with target URL and hostname allowlist can be activated.",
          });
        if (
          item.state === "active" &&
          String(item.title).toLowerCase().includes("consistent character") &&
          !(typeof item.approvedBrief === "string" && item.approvedBrief.trim())
        )
          return send(400, {
            error:
              "Confirm and save the character brief before activating this workflow.",
          });
        let workflows: Record<string, unknown>[] = [];
        try {
          workflows = JSON.parse(await readFile(WORKFLOWS_PATH, "utf8"));
        } catch {
          /* first save */
        }
        workflows = workflows.filter((existing) => existing.id !== item.id);
        workflows.unshift({ ...item, updatedAt: new Date().toISOString() });
        await mkdir(VAULT_DIR, { recursive: true });
        const temporary = WORKFLOWS_PATH + ".tmp";
        await writeFile(temporary, JSON.stringify(workflows.slice(0, 100)), {
          mode: 0o600,
        });
        await rename(temporary, WORKFLOWS_PATH);
        return send(200, { ok: true, workflows });
      }
      if (
        (url.pathname === "/__local-model/browser-health" ||
          url.pathname === "/browser-health") &&
        req.method === "GET"
      ) {
        const ollama = await fetch(`${OLLAMA}/api/tags`, {
          signal: AbortSignal.timeout(3000),
        })
          .then(async (r) => ({
            ok: r.ok,
            models: ((await r.json()) as { models?: unknown[] }).models || [],
          }))
          .catch(() => ({ ok: false, models: [] }));
        let worker = false,
          running = false,
          workerError = "";
        try {
          const r = await fetch(`${BROWSER}/workflow`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "status" }),
            signal: AbortSignal.timeout(1500),
          });
          const d = (await r.json()) as { running?: boolean };
          worker = r.ok;
          running = !!d.running;
          if (!r.ok) workerError = "Worker returned an error.";
        } catch {
          workerError =
            browserWorkerError ||
            browserWorkerOutput ||
            "Worker process is not responding on 127.0.0.1:4201.";
        }
        return send(200, {
          ok: worker && ollama.ok,
          worker,
          running,
          ollama: ollama.ok,
          modelCount: ollama.models.length,
          error: !ollama.ok
            ? "Ollama is not reachable on 127.0.0.1:11434."
            : workerError,
        });
      }
      if (
        (url.pathname === "/__local-model/browser-start" ||
          url.pathname === "/browser-start") &&
        req.method === "POST"
      ) {
        try {
          const response = await fetch(`${BROWSER}/workflow`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "launch" }),
            signal: AbortSignal.timeout(15000),
          });
          const data = (await response.json()) as {
            error?: string;
            running?: boolean;
            url?: string;
          };
          if (!response.ok) return send(response.status, data);
          if (data.running)
            return send(200, {
              ok: true,
              started: true,
              running: true,
              url: data.url || "",
            });
        } catch {
          /* Worker not yet responding — fall through to spawn below. */
        }
        if (
          !browserWorker ||
          browserWorker.exitCode !== null ||
          browserWorker.killed
        ) {
          browserWorkerError = "";
          browserWorkerOutput = "";
          const { spawn } = await import("node:child_process");
          browserWorker = spawn(
            process.execPath,
            [join(process.cwd(), "browser-worker.cjs")],
            {
              cwd: process.cwd(),
              env: { ...process.env, LOCALPILOT_BROWSER_PORT: "4201" },
              windowsHide: false,
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          browserWorker.stdout?.on("data", (chunk) => {
            browserWorkerOutput += String(chunk).slice(0, 4000);
          });
          browserWorker.stderr?.on("data", (chunk) => {
            browserWorkerError += String(chunk).slice(0, 4000);
          });
          browserWorker.on("error", (error) => {
            browserWorkerError = error.message;
          });
          browserWorker.on("exit", (code, signal) => {
            if (code !== 0)
              browserWorkerError =
                browserWorkerError ||
                `Worker exited (code ${code}, signal ${signal || "none"}).`;
          });
          browserWorker.unref();
        }
        for (let i = 0; i < 40; i++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          try {
            const r = await fetch(`${BROWSER}/workflow`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "launch" }),
              signal: AbortSignal.timeout(1500),
            });
            const d = (await r.json()) as {
              error?: string;
              running?: boolean;
              url?: string;
            };
            if (r.ok && d.running)
              return send(200, {
                ok: true,
                started: true,
                running: true,
                url: d.url || "",
              });
            if (!r.ok) browserWorkerError = d.error || browserWorkerError;
          } catch {
            /* Keep polling until launch succeeds or attempts run out. */
          }
          if (
            browserWorker?.exitCode !== null &&
            browserWorker?.exitCode !== undefined
          )
            break;
        }
        return send(503, {
          ok: false,
          running: false,
          error:
            browserWorkerError ||
            browserWorkerOutput ||
            "Browser worker did not start. Check that Playwright and its Chromium browser are installed.",
        });
      }
      if (
        (url.pathname === "/__local-model/browser" ||
          url.pathname === "/browser") &&
        req.method === "POST"
      ) {
        const body = await readBody();
        try {
          const response = await fetch(`${BROWSER}/workflow`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(45000),
          });
          const result = await response.json();
          return send(response.status, result);
        } catch (error) {
          return send(503, {
            error:
              browserWorkerError ||
              browserWorkerOutput ||
              (error instanceof Error
                ? error.message
                : "Browser worker is unavailable. Start it from the local dashboard."),
          });
        }
      }
      if (
        (url.pathname === "/__local-model/settings" ||
          url.pathname === "/settings") &&
        req.method === "GET"
      ) {
        const vault = await loadVault();
        const telegram = await readTelegramCredentials();
        return send(200, {
          cloudConfigured: !!vault.cloud,
          telegramConfigured: !!telegram?.token,
          telegramChatId: telegram?.chatId || "",
          vaultAvailable: !!VAULT_KEY,
        });
      }
      if (
        (url.pathname === "/__local-model/settings" ||
          url.pathname === "/settings") &&
        req.method === "POST"
      ) {
        const body = await readBody();
        const provider = String(body.provider || "");
        const secret = String(body.secret || "").trim();
        const chatId = String(body.chatId || "").trim();
        if (!["cloud", "telegram"].includes(provider))
          return send(400, { error: "Unknown credential type." });
        if (!VAULT_KEY)
          return send(503, {
            error:
              "Credential vault is locked. Configure LOCALPILOT_VAULT_PASSWORD in the local environment and restart Personal Agent.",
          });
        const vault = await loadVault();
        if (provider === "telegram") {
          const existing = await readTelegramCredentials();
          const token = secret || existing?.token || "";
          if (!token)
            return send(400, { error: "Enter the Telegram bot token first." });
          if (secret && (secret.length < 8 || secret.length > 4096))
            return send(400, {
              error: "Credential must be between 8 and 4096 characters.",
            });
          if (!/^\d{5,20}$/.test(chatId || existing?.chatId || ""))
            return send(400, {
              error: "Enter the numeric Telegram chat ID (from @userinfobot or similar).",
            });
          vault.telegram = encryptSecret(
            JSON.stringify({
              token,
              chatId: chatId || existing?.chatId || "",
            }),
          );
          await saveVault(vault);
          return send(200, { ok: true });
        }
        if (secret.length < 8 || secret.length > 4096)
          return send(400, {
            error: "Credential must be between 8 and 4096 characters.",
          });
        vault[provider] = encryptSecret(secret);
        await saveVault(vault);
        return send(200, { ok: true });
      }
      if (
        (url.pathname === "/__local-model/settings" ||
          url.pathname === "/settings") &&
        req.method === "DELETE"
      ) {
        const body = await readBody();
        const provider = String(body.provider || "");
        if (!["cloud", "telegram"].includes(provider))
          return send(400, { error: "Unknown credential type." });
        const vault = await loadVault();
        delete vault[provider];
        await saveVault(vault);
        return send(200, { ok: true });
      }
      if (
        (url.pathname === "/__local-model/providers" ||
          url.pathname === "/providers") &&
        req.method === "GET"
      ) {
        const providers = await readProviders();
        return send(200, {
          providers: providers.map(({ id, label, baseUrl, model }) => ({
            id,
            label,
            baseUrl,
            model,
          })),
          vaultAvailable: !!VAULT_KEY,
        });
      }
      if (
        (url.pathname === "/__local-model/providers" ||
          url.pathname === "/providers") &&
        req.method === "POST"
      ) {
        if (!VAULT_KEY)
          return send(503, {
            error:
              "Credential vault is locked. Configure LOCALPILOT_VAULT_PASSWORD in the local environment and restart Personal Agent.",
          });
        const body = await readBody();
        const id = String(body.id || "").trim();
        const label = String(body.label || "").trim().slice(0, 80);
        const baseUrl = String(body.baseUrl || "").trim();
        const model = String(body.model || "").trim().slice(0, 160);
        const apiKey = String(body.apiKey || "").trim();
        if (!label) return send(400, { error: "Enter a label for the provider." });
        if (!isAllowedProviderBaseUrl(baseUrl))
          return send(400, {
            error:
              "Enter a valid http(s) base URL. Public providers must use https; http is only allowed for localhost networks.",
          });
        if (!model) return send(400, { error: "Enter the model identifier to use." });
        const providers = await readProviders();
        const existing = id ? providers.find((p) => p.id === id) : undefined;
        if (id && !existing)
          return send(404, { error: "Provider not found. Refresh and try again." });
        if (!existing && apiKey.length < 8)
          return send(400, { error: "Enter the provider API key (at least 8 characters)." });
        if (apiKey && (apiKey.length < 8 || apiKey.length > 4096))
          return send(400, { error: "API key must be between 8 and 4096 characters." });
        const record = {
          id: existing?.id || randomUUID(),
          label,
          baseUrl: baseUrl.replace(/\/+$/, ""),
          model,
          apiKey: apiKey || existing!.apiKey,
        };
        const next = existing
          ? providers.map((p) => (p.id === record.id ? record : p))
          : [...providers, record];
        await saveProviders(next);
        return send(200, {
          ok: true,
          providers: next.map(({ id: pid, label: l, baseUrl: b, model: m }) => ({
            id: pid, label: l, baseUrl: b, model: m,
          })),
        });
      }
      if (
        (url.pathname === "/__local-model/providers" ||
          url.pathname === "/providers") &&
        req.method === "DELETE"
      ) {
        const body = await readBody();
        const id = String(body.id || "").trim();
        if (!id) return send(400, { error: "Provider id is required." });
        const providers = await readProviders();
        const next = providers.filter((p) => p.id !== id);
        await saveProviders(next);
        return send(200, { ok: true });
      }
      if (
        (url.pathname === "/__local-model/telegram-notify" ||
          url.pathname === "/telegram-notify") &&
        req.method === "POST"
      ) {
        const body = await readBody();
        const text = String(body.text || "").trim();
        if (!text)
          return send(400, { error: "Message text is required." });
        const creds = await readTelegramCredentials();
        if (!creds?.token || !creds.chatId)
          return send(200, { sent: false, reason: "not-configured" });
        const result = await sendTelegramMessage(
          creds.token,
          creds.chatId,
          text.slice(0, 3500),
        );
        return send(200, { sent: result.ok, error: result.error });
      }
      if (
        (url.pathname === "/__local-model/telegram-test" ||
          url.pathname === "/telegram-test") &&
        req.method === "POST"
      ) {
        const creds = await readTelegramCredentials();
        if (!creds?.token || !creds.chatId)
          return send(400, {
            error:
              "Telegram bot token and chat ID must be saved first (Settings).",
          });
        const result = await sendTelegramMessage(
          creds.token,
          creds.chatId,
          "Personal Agent test notification — Telegram delivery is wired up. You will receive approvals, workflow results and errors here.",
        );
        if (!result.ok)
          return send(502, { error: result.error || "Telegram rejected the message." });
        return send(200, { ok: true });
      }
      if (
        (url.pathname === "/__local-model/health" ||
          url.pathname === "/health") &&
        req.method === "GET"
      ) {
        const response = await fetch(`${OLLAMA}/api/tags`, {
          signal: AbortSignal.timeout(4000),
        });
        if (!response.ok)
          return send(502, {
            ok: false,
            error: `Ollama returned HTTP ${response.status}`,
          });
        return send(200, {
          ok: true,
          provider: "Ollama",
          endpoint: "127.0.0.1:11434",
        });
      }
      if (
        (url.pathname === "/__local-model/models" ||
          url.pathname === "/models") &&
        req.method === "GET"
      ) {
        const response = await fetch(`${OLLAMA}/api/tags`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok)
          return send(502, {
            error: `Ollama returned HTTP ${response.status}`,
          });
        const payload = (await response.json()) as {
          models?: Array<{
            name?: string;
            model?: string;
            details?: { parameter_size?: string };
          }>;
        };
        const allModels = (payload.models || [])
          .map((item) => ({
            name: item.name || item.model || "",
            parameterSize: item.details?.parameter_size || "",
          }))
          .filter((item) => item.name)
          .sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
          )
          .filter(
            (item, index, list) =>
              list.findIndex((other) => other.name === item.name) === index,
          );
        const isCloudTag = (name: string) =>
          /(?:^|:)cloud(?:$|[-])|[-:]cloud$/i.test(name);
        const models = allModels.filter((item) => !isCloudTag(item.name));
        const cloudModels = allModels.filter((item) => isCloudTag(item.name));
        cloudModels.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
        );
        return send(200, { models, cloudModels });
      }
      if (
        (url.pathname === "/__local-model/chat" || url.pathname === "/chat") &&
        req.method === "POST"
      ) {
        const body = await readBody();
        const providerId = String(body.providerId || "").trim();
        const model = String(body.model || "");
        const messages = body.messages;
        if (
          !Array.isArray(messages) ||
          !messages.length ||
          messages.length > 40
        )
          return send(400, {
            error: "Provide between 1 and 40 conversation messages.",
          });
        let safeMessages: Array<{ role: string; content: string }>;
        try {
          safeMessages = messages.map((message) => {
            const item = message as { role?: unknown; content?: unknown };
            if (
              !["system", "user", "assistant"].includes(String(item.role)) ||
              typeof item.content !== "string"
            )
              throw new Error("Invalid message format.");
            if (item.content.length > 200000)
              throw new Error("Conversation message exceeds 200,000 characters. Shorten the workload or start a fresh run.");
            return { role: String(item.role), content: item.content };
          });
        } catch (messageError) {
          return send(400, {
            error:
              messageError instanceof Error
                ? messageError.message
                : "Invalid message format.",
          });
        }
        if (providerId) {
          if (!VAULT_KEY)
            return send(503, {
              error:
                "Credential vault is locked. Configure LOCALPILOT_VAULT_PASSWORD and restart Personal Agent before using API providers.",
            });
          const provider = (await readProviders()).find((p) => p.id === providerId);
          if (!provider)
            return send(404, {
              error: "That API provider was not found. Remove it and add it again from Settings.",
            });
          if (!isAllowedProviderBaseUrl(provider.baseUrl))
            return send(400, {
              error: "The saved provider base URL is no longer allowed (https required, or http on localhost only).",
            });
          const controller = new AbortController();
          const disconnected = () => { if (!res.writableEnded) controller.abort(); };
          res.once("close", disconnected);
          try {
            const result = await requestProviderChat(
              provider.baseUrl,
              provider.apiKey,
              { model: provider.model, messages: safeMessages },
              AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
            );
            return send(200, {
              ...result,
              model: provider.model,
              provider: provider.label,
              inference: "provider",
            });
          } catch (error) {
            if (error instanceof Error && error.name === "TimeoutError")
              return send(504, {
                error: `${provider.label} did not respond within 180 seconds. No draft was created.`,
              });
            return send(502, {
              error: `${provider.label} request failed: ${error instanceof Error ? error.message : "unknown error"}`,
            });
          } finally {
            res.off("close", disconnected);
          }
        }
        if (!model)
          return send(400, { error: "Choose an Ollama model first." });
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model))
          return send(400, { error: "Invalid Ollama model name." });
        const installed = await fetch(`${OLLAMA}/api/tags`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!installed.ok)
          return send(502, {
            error: `Could not verify installed Ollama models (HTTP ${installed.status}).`,
          });
        const inventory = (await installed.json()) as {
          models?: Array<{ name?: string; model?: string }>;
        };
        const installedModelNames = (inventory.models || [])
          .map((item) => item.name || item.model || "")
          .filter(Boolean);
        if (!isCloudModel(model) && !installedModelNames.includes(model))
          return send(400, {
            error: `“${model}” is not currently installed in local Ollama. Refresh Local models and select an installed model.`,
          });
        const controller = new AbortController();
        const disconnected = () => { if (!res.writableEnded) controller.abort(); };
        res.once("close", disconnected);
        try {
          const result = await requestLocalChat(OLLAMA, {
            model, messages: safeMessages, format: body.format, purpose: body.purpose,
          }, AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]));
          return send(200, { ...result, model, inference: isCloudModel(model) ? "cloud" : "local" });
        } catch (error) {
          if (error instanceof Error && error.name === "TimeoutError")
            return send(504, { error: "Local inference exceeded 180 seconds. No draft was created. The selected model may still be loading or processing the workload; try a smaller local model." });
          throw error;
        } finally {
          res.off("close", disconnected);
        }
      }
      return send(404, { error: "Unknown local model route." });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Local model request failed.";
      return send(502, {
        error:
          message.includes("fetch failed") || message.includes("ECONNREFUSED")
            ? "Ollama is unreachable at 127.0.0.1:11434. Start the local Ollama service and retry."
            : message,
      });
    }
  };

  return {
    name: "local-model-bridge",
    configureServer(server) {
      server.middlewares.use("/__local-model", (req, res) => {
        void handler(req, res);
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__local-model", (req, res) => {
        void handler(req, res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localModelBridge()],
});
