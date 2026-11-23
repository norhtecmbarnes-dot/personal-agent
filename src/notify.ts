// Fire-and-forget Telegram notification via the local bridge.
// Never throws; a failed notification must never break a workflow.
export async function notifyTelegram(text: string): Promise<void> {
  try {
    await fetch("/__local-model/telegram-notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, 1000) }),
    });
  } catch {
    // notification is best-effort only
  }
}
