// Only this application's origin gets a bridge; no all-sites permission.
const commands = ["PING", "SOURCES", "CAPTURE", "RUN", "STATUS", "RESULT", "IMAGE", "RETRY", "CANCEL", "FRAMES"];
window.addEventListener("message", async (event) => {
  if (event.source !== window || event.origin !== location.origin || event.data?.channel !== "video-studio-request") return;
  const { id, command, payload } = event.data;
  if (typeof id !== "string" || !commands.includes(command)) return;
  try {
    const result = await chrome.runtime.sendMessage({ command, payload });
    window.postMessage({ channel: "video-studio-response", id, ...result }, location.origin);
  } catch {
    window.postMessage({ channel: "video-studio-response", id, error: "PC連携を読み直してください。Chrome拡張の更新後は制作画面の再読み込みが必要です。" }, location.origin);
  }
});
