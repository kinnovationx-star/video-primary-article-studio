// Drives dedicated Claude / ChatGPT tabs for the studio page. Jobs are multi-step
// conversations: each step is sent only after the previous reply has settled.
const sourcePatterns = ["https://app.neilpatel.com/*", "https://analytics.google.com/*", "https://search.google.com/search-console/*"];
const allowedOrigins = new Set(["https://video-primary-article-studio.k-innovationx.workers.dev", "http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000", "http://127.0.0.1:5173"]);
const providers = { claude: { url: "https://claude.ai/new", host: "claude.ai" }, gpt: { url: "https://chatgpt.com/", host: "chatgpt.com" } };
const STEP_TIMEOUT = 20 * 60 * 1000;
const OPEN_TIMEOUT = 3 * 60 * 1000;
const SETTLE_MS = { claude: 6000, gpt: 8000 };
const NUDGE = {
  gpt: "確認や質問は不要です。直前の指示どおり、画像を今すぐ1枚生成してください。",
  claude: "アーティファクトやファイルは使わず、同じ内容を会話本文にMarkdownで直接出力してください。",
};
let queue = Promise.resolve();
const tabUrl = tab => String(tab?.url || tab?.pendingUrl || "");
const jobKey = id => `job:${id}`;
const imageKey = (id, index) => `img:${id}:${index}`;
const load = async id => (await chrome.storage.local.get(jobKey(id)))[jobKey(id)];
const save = job => chrome.storage.local.set({ [jobKey(job.id)]: job });

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!sender.tab || sender.frameId !== 0 || !allowedOrigins.has(sender.origin)) return;
  const task = queue.then(() => handle(message, sender));
  queue = task.catch(() => {});
  task.then(value => reply({ value }), error => reply({ error: error?.message || "PC連携の処理が止まりました。" }));
  return true;
});

function summary(job) {
  return {
    id: job.id, provider: job.provider, purpose: job.purpose, state: job.state, error: job.error || "", url: job.url || "",
    step: job.step, total: job.steps.length, createdAt: job.createdAt, attachWarning: job.attachWarning || "",
    results: job.steps.map((_, index) => job.results[index] ? { chars: job.results[index].text.length, imageCount: job.results[index].imageCount || 0 } : null),
  };
}
function attention(job, message) { job.state = "attention"; job.error = message; }

async function workWindow() {
  const { workWindowId } = await chrome.storage.local.get("workWindowId");
  if (workWindowId) try { await chrome.windows.get(workWindowId); return workWindowId; } catch { /* closed */ }
  const created = await chrome.windows.create({ url: "about:blank", focused: false, width: 1280, height: 900 });
  await chrome.storage.local.set({ workWindowId: created.id });
  return created.id;
}
async function openTab(job) {
  const windowId = await workWindow().catch(() => undefined);
  const tab = await chrome.tabs.create({ url: job.startUrl || providers[job.provider].url, active: true, ...(windowId ? { windowId } : {}) });
  job.tabId = tab.id; job.openedAt = Date.now(); job.url = "";
}

function validSteps(payload) {
  const steps = Array.isArray(payload?.steps) ? payload.steps : typeof payload?.prompt === "string" ? [{ prompt: payload.prompt }] : null;
  if (!steps?.length || steps.length > 12) return null;
  for (const step of steps) {
    if (typeof step?.prompt !== "string" || !step.prompt.trim() || step.prompt.length > 150000) return null;
    if (step.attachments && (!Array.isArray(step.attachments) || step.attachments.length > 6 || step.attachments.some(a => !/^data:image\/(png|jpeg|webp);base64,/.test(String(a?.dataUrl)) || a.dataUrl.length > 12_000_000))) return null;
  }
  return steps.map(step => ({ prompt: step.prompt, attachments: step.attachments || [], expectImage: !!step.expectImage }));
}

async function handle({ command, payload }, sender) {
  if (command === "PING") return { version: chrome.runtime.getManifest().version };
  if (command === "SOURCES") return (await chrome.tabs.query({ url: sourcePatterns }))
    .map(tab => ({ id: tab.id, title: tab.title || "分析画面", url: tabUrl(tab) }))
    .filter(tab => Number.isInteger(tab.id) && /^https:\/\//.test(tab.url));
  if (command === "CAPTURE") {
    const tab = await chrome.tabs.get(Number(payload?.tabId));
    const currentUrl = tabUrl(tab);
    if (!currentUrl || tab.status !== "complete") throw new Error("分析画面を読み込み中です。数秒後にもう一度お試しください。");
    const u = new URL(currentUrl);
    if (!["app.neilpatel.com", "analytics.google.com", "search.google.com"].includes(u.hostname) || (u.hostname === "search.google.com" && !u.pathname.startsWith("/search-console/"))) throw new Error("分析対象の画面ではありません。");
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => (document.querySelector("main") || document.body).innerText });
    const text = String(result?.result || "");
    if (text.length < 40) throw new Error("数値表を読み取れません。ログインとレポート画面を確認してください。");
    return { text: text.slice(0, 80000), title: tab.title, url: currentUrl, capturedAt: new Date().toISOString() };
  }
  if (command === "FRAMES") return captureFrames(payload, sender);
  if (command === "RUN") {
    const steps = validSteps(payload);
    if (!payload || !/^[a-zA-Z0-9-]{10,80}$/.test(payload.id) || !providers[payload.provider] || !steps) throw new Error("依頼内容を確認してください（1ステップ15万文字まで）。");
    const existing = await load(payload.id);
    if (existing) return summary(existing); // idempotent even if the caller lost its response
    await prune();
    // Continuing an existing conversation keeps its context (e.g. the transcript Claude already read).
    const startUrl = /^https:\/\/(claude\.ai\/chat|chatgpt\.com\/c)\/[\w-]+$/.test(String(payload.startUrl || "")) && new URL(payload.startUrl).hostname === providers[payload.provider].host ? payload.startUrl : "";
    const job = { id: payload.id, provider: payload.provider, purpose: String(payload.purpose || ""), startUrl, steps, step: 0, results: [], sendQueue: [{ index: 0 }], state: "opening", createdAt: new Date().toISOString() };
    await save(job);
    try { await openTab(job); } catch { attention(job, "専用タブを開けませんでした。"); }
    await save(job);
    return summary(job);
  }
  const job = payload?.id ? await load(String(payload.id)) : null;
  if (["STATUS", "RESULT", "IMAGE", "RETRY", "CANCEL"].includes(command) && !job) throw new Error("依頼が見つかりません。制作画面からやり直してください。");
  if (command === "STATUS") { await advance(job, sender); await save(job); return summary(job); }
  if (command === "RESULT") {
    const result = job.results[Number(payload.step)];
    if (!result) throw new Error("このステップの回答はまだありません。");
    return { text: result.text, html: result.html };
  }
  if (command === "IMAGE") {
    const key = imageKey(job.id, Number(payload.step));
    const dataUrl = (await chrome.storage.local.get(key))[key];
    if (!dataUrl) throw new Error("このステップの画像はまだありません。");
    return { dataUrl };
  }
  if (command === "CANCEL") { job.state = "cancelled"; await save(job); return summary(job); }
  if (command === "RETRY") {
    if (job.state !== "attention") return summary(job);
    const index = job.sendQueue[0]?.index ?? job.step;
    let alive = false;
    try { alive = !!job.tabId && new URL(tabUrl(await chrome.tabs.get(job.tabId))).hostname === providers[job.provider].host; } catch { alive = false; }
    // A fresh tab has no context; replay the material step first for later Claude steps.
    job.sendQueue = !alive && !job.startUrl && job.provider === "claude" && index > 0 ? [{ index: 0, discard: true }, { index }] : [{ index }];
    job.state = "opening"; job.error = "";
    // A conversation that already exists is reopened by its own URL, keeping its context.
    if (!alive) { if (job.url && /^https:\/\/(claude\.ai\/chat|chatgpt\.com\/c)\//.test(job.url)) job.startUrl = job.url; await openTab(job); } else job.openedAt = Date.now();
    await save(job);
    return summary(job);
  }
  throw new Error("未対応の操作です。拡張機能と制作画面を再読み込みしてください。");
}

async function advance(job, sender) {
  if (!["opening", "sending", "waiting"].includes(job.state)) return;
  let tab;
  try { tab = await chrome.tabs.get(job.tabId); } catch { attention(job, "専用タブが閉じられました。「再試行」で新しいタブから続行できます。"); return; }
  const url = tabUrl(tab);
  job.url = url;
  if (!url || tab.status !== "complete") {
    if (job.state === "opening" && Date.now() - job.openedAt > OPEN_TIMEOUT) attention(job, "専用タブの読み込みが終わりません。ネットワークとログイン状態を確認してください。");
    return;
  }
  if (new URL(url).hostname !== providers[job.provider].host) { attention(job, "専用タブが別のサイトへ移動しました。タブを確認してから「再試行」してください。"); return; }
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["assistant-page.js"] });
  const entry = job.sendQueue[0];
  if (job.state === "sending") { attention(job, "送信処理の途中で接続が切れました。専用タブで送信済みか確認し、未送信なら「再試行」を押してください。"); return; }
  if (job.state === "opening") {
    const probe = await chrome.tabs.sendMessage(tab.id, { action: "PROBE" });
    if (!probe?.ready) {
      if (Date.now() - job.openedAt > OPEN_TIMEOUT) attention(job, probe?.reason || "入力欄が表示されません。");
      return;
    }
    const step = job.steps[entry.index];
    // Already sent (e.g. retry after a lost reply)? Follow that answer instead of sending twice.
    const promptHead = (entry.prompt || step.prompt).replace(/\s+/g, "").slice(0, 40);
    const existing = await chrome.tabs.sendMessage(tab.id, { action: "READ", baseCount: 0, promptHead });
    if (existing?.sent) {
      job.state = "waiting"; job.error = ""; job.promptHead = promptHead; job.baseCount = 0; job.sentAt = Date.now(); job.signature = ""; job.stableSince = Date.now();
      return;
    }
    job.state = "sending"; // intent recorded first: a lost reply is never re-sent automatically
    await save(job);
    const back = sender?.tab;
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
    } catch { /* focusing is best effort */ }
    let response;
    try { response = await chrome.tabs.sendMessage(tab.id, { action: "SEND", prompt: entry.prompt || step.prompt, attachments: entry.prompt ? [] : step.attachments }); }
    catch { response = { error: "送信中に専用タブとの接続が切れました。専用タブで送信済みか確認し、未送信なら「再試行」を押してください（自動再送はしません）。" }; }
    if (back) try { await chrome.windows.update(back.windowId, { focused: true }); await chrome.tabs.update(back.id, { active: true }); } catch { /* best effort */ }
    if (!response?.ok) { attention(job, response?.error || "送信できませんでした。"); return; }
    job.state = "waiting"; job.error = ""; job.baseCount = response.baseCount; job.promptHead = response.promptHead || ""; job.sentAt = Date.now(); job.signature = ""; job.stableSince = Date.now();
    if (response.attachWarning) job.attachWarning = response.attachWarning;
    return;
  }
  const read = await chrome.tabs.sendMessage(tab.id, { action: "READ", baseCount: job.baseCount, promptHead: job.promptHead || "" });
  if (read.loginRequired) { attention(job, "ログインが必要です。専用タブでログインしてから「再試行」を押してください。"); return; }
  const timedOut = Date.now() - job.sentAt > STEP_TIMEOUT;
  if (read.hasReply === false || (read.hasReply === undefined && read.count <= job.baseCount)) { if (timedOut) attention(job, "20分待っても回答が始まりません。利用上限・エラー表示を専用タブで確認してください。"); return; }
  const signature = `${read.text.length}|${read.imageKeys.join(",")}|${read.busy}`;
  if (signature !== job.signature || read.busy) { job.signature = signature; job.stableSince = Date.now(); }
  const settled = !read.busy && Date.now() - job.stableSince >= SETTLE_MS[job.provider];
  if (!settled) { if (timedOut) attention(job, "20分以内に回答が完了しませんでした。専用タブを確認してください。"); return; }
  const step = job.steps[entry.index];
  const missingImage = step.expectImage && !read.imageKeys.length;
  const artifactOnly = job.provider === "claude" && read.artifact && read.text.length < 600;
  if (missingImage || artifactOnly) {
    if (missingImage && Date.now() - job.stableSince < 30000) return; // image rendering can start late
    if (!entry.nudged) { entry.prompt = NUDGE[job.provider]; entry.nudged = true; job.state = "opening"; return; }
    attention(job, missingImage ? `画像が生成されませんでした。ChatGPTの回答: ${read.text.slice(0, 160)}` : "Claudeがアーティファクトに出力しました。会話本文への出力を依頼してください。");
    return;
  }
  let imageCount = 0;
  if (step.expectImage) {
    const image = await chrome.tabs.sendMessage(tab.id, { action: "IMAGE", baseCount: job.baseCount, promptHead: job.promptHead || "" });
    let dataUrl = image?.dataUrl || "";
    if (!dataUrl && image?.src && /^https:/.test(image.src)) dataUrl = await fetchAsDataUrl(image.src).catch(() => "");
    if (!dataUrl) { attention(job, image?.error || "生成画像を取得できませんでした。"); return; }
    await chrome.storage.local.set({ [imageKey(job.id, entry.index)]: dataUrl });
    imageCount = 1;
  }
  job.sendQueue.shift();
  if (!entry.discard) {
    job.results[entry.index] = { text: read.text, html: read.html, imageCount };
    job.step = entry.index + 1;
    if (entry.index + 1 < job.steps.length) job.sendQueue.push({ index: entry.index + 1 });
  }
  job.state = job.sendQueue.length ? "opening" : "review";
  job.openedAt = Date.now();
}

// Finished jobs older than 14 days are removed together with their images.
async function prune() {
  const everything = await chrome.storage.local.get(null);
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const stale = Object.entries(everything)
    .filter(([key, job]) => key.startsWith("job:") && !["opening", "sending", "waiting"].includes(job?.state) && Date.parse(job?.createdAt) < cutoff)
    .map(([, job]) => job.id);
  if (!stale.length) return;
  await chrome.storage.local.remove(Object.keys(everything).filter(key => stale.some(id => key === jobKey(id) || key.startsWith(`img:${id}:`))));
}

async function fetchAsDataUrl(src) {
  const blob = await (await fetch(src)).blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || "image/png"};base64,${btoa(binary)}`;
}

// ---------- real video frames (H2 images) ----------
// Opens the YouTube video in the work window, then for each requested time picks the sharpest
// frame within ±2 seconds and crops a 16:9 area between the burned-in titles and subtitles.
async function frameTab(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const { frameTabId } = await chrome.storage.local.get("frameTabId");
  let tab = null;
  if (frameTabId) try { tab = await chrome.tabs.get(frameTabId); } catch { tab = null; }
  if (tab && new URL(tabUrl(tab)).searchParams.get("v") === videoId) { await chrome.tabs.update(tab.id, { active: true }); return tab; }
  if (tab) tab = await chrome.tabs.update(tab.id, { url, active: true });
  else {
    const windowId = await workWindow().catch(() => undefined);
    tab = await chrome.tabs.create({ url, active: true, ...(windowId ? { windowId } : {}) });
    await chrome.storage.local.set({ frameTabId: tab.id });
  }
  for (let i = 0; i < 60; i++) {
    tab = await chrome.tabs.get(tab.id);
    if (tab.status === "complete" && tabUrl(tab).includes(videoId)) return tab;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("YouTubeの動画ページを読み込めませんでした。");
}

async function preparePlayer() {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let i = 0; i < 20 && document.visibilityState !== "visible"; i++) await sleep(500);
  if (document.visibilityState !== "visible") return { error: "YouTubeのタブが画面に表示されていないため動画を読み込めません。Chromeの作業ウィンドウを最小化しないでください。" };
  let video = null;
  for (let i = 0; i < 40 && !(video = document.querySelector("video.html5-main-video")); i++) await sleep(500);
  if (!video) return { error: "YouTubeの動画プレーヤーが見つかりません。" };
  const player = document.getElementById("movie_player");
  for (let i = 0; i < 180 && player?.classList.contains("ad-showing"); i++) {
    document.querySelector(".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern")?.click();
    await sleep(500);
  }
  if (player?.classList.contains("ad-showing")) return { error: "YouTube広告が終わらないため場面を切り出せませんでした。" };
  video.muted = true;
  try {
    const levels = player.getAvailableQualityLevels();
    const best = levels.find(level => /hd2160|hd1440|hd1080/.test(level)) || levels[0];
    player.setPlaybackQualityRange(best, best);
  } catch { /* quality stays automatic */ }
  try { await video.play(); } catch { /* seeking still works while paused */ }
  await sleep(3000);
  video.pause();
  return { duration: video.duration, quality: player?.getPlaybackQuality?.() || "" };
}

// Runs in the YouTube page: frames around `center` (every `step` seconds), downscaled for analysis.
async function sampleFrames(center, span, step) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const video = document.querySelector("video.html5-main-video");
  if (!video) return { error: "動画プレーヤーが見つかりません。" };
  const duration = video.duration || 0, frames = [];
  for (let offset = -span; offset <= span + 1e-9; offset += step) {
    const time = Math.min(Math.max(1, center + offset), Math.max(1, duration - 1));
    if (frames.some(frame => Math.abs(frame.time - time) < step / 2)) continue;
    video.currentTime = time;
    await new Promise(resolve => { video.addEventListener("seeked", resolve, { once: true }); setTimeout(resolve, 6000); });
    await sleep(350);
    if (!video.videoWidth) continue;
    const canvas = document.createElement("canvas");
    canvas.width = 1280; canvas.height = Math.round(1280 * video.videoHeight / video.videoWidth);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push({ time, dataUrl: canvas.toDataURL("image/jpeg", 0.85) });
  }
  return { frames, width: video.videoWidth, height: video.videoHeight, duration };
}

// Runs in the YouTube page: the chosen frame at full resolution, cropped to the chosen box.
async function cropFrame(time, crop) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const video = document.querySelector("video.html5-main-video");
  video.currentTime = time;
  await new Promise(resolve => { video.addEventListener("seeked", resolve, { once: true }); setTimeout(resolve, 6000); });
  await sleep(500);
  const W = video.videoWidth, H = video.videoHeight;
  const sx = Math.round(crop.x0 * W), sy = Math.round(crop.y0 * H), sw = Math.round((crop.x1 - crop.x0) * W), sh = Math.round((crop.y1 - crop.y0) * H);
  const outW = Math.min(1920, sw), outH = Math.round(outW * sh / sw), out = document.createElement("canvas");
  out.width = outW; out.height = outH;
  const context = out.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(video, sx, sy, sw, sh, 0, 0, outW, outH);
  return { dataUrl: out.toDataURL("image/jpeg", 0.92), source: `${W}x${H}`, size: `${outW}x${outH}` };
}

async function ensureAnalyser() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (!contexts.length) await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["DOM_PARSER"], justification: "動画フレームの顔・目・構図をローカルで判定する" });
}
async function analyser(message) {
  await ensureAnalyser();
  const response = await chrome.runtime.sendMessage({ target: "frame-analyser", ...message });
  if (response?.error) throw new Error(`画像判定に失敗しました: ${response.error}`);
  return response?.value;
}

// One H2 image: search around the target time, then further away, until a frame passes every check.
async function bestFrame(tab, target, taken, log) {
  const run = async (func, args) => (await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func, args }))[0]?.result;
  const duration = (await run(sampleFrames, [0, 0, 1]))?.duration || 0;
  // Near the requested moment first, then spread over the whole video.
  const near = target >= 0 ? [0, 12, -12, 30, -30, 60, -60, 120, -120].map(offset => target + offset) : [];
  const spread = [0.2, 0.35, 0.5, 0.65, 0.8, 0.27, 0.42, 0.57, 0.72].map(share => duration * share);
  const tried = [];
  let attempt = 0;
  for (const center of [...near, ...spread]) {
    if (!duration || center < 3 || center > duration - 3) continue;
    if (taken.some(time => Math.abs(time - center) < 20) || tried.some(time => Math.abs(time - center) < 8)) continue;
    tried.push(center);
    attempt++;
    const sampled = await run(sampleFrames, [center, 6, 1]);
    if (!sampled?.frames?.length) continue;
    const minHeight = Math.min(0.68, Math.max(0.45, 700 / sampled.height));
    const analysed = await analyser({ type: "ANALYZE", frames: sampled.frames, minHeight });
    const passed = analysed.filter(item => item.score >= 0 && !taken.some(time => Math.abs(time - item.time) < 20)).sort((a, b) => b.score - a.score);
    log.push(`${Math.round(center)}秒付近: ${sampled.frames.length}コマ中${passed.length}コマ合格`);
    for (const candidate of passed.slice(0, 3)) {
      const cropped = await run(cropFrame, [candidate.time, candidate.crop]);
      const checked = await analyser({ type: "VERIFY", dataUrl: cropped.dataUrl });
      if (checked.ok) return { dataUrl: cropped.dataUrl, seconds: Math.round(candidate.time), source: cropped.source, size: cropped.size, attempts: attempt };
      log.push(`${Math.round(candidate.time)}秒: 切り抜き後の確認で不合格（${checked.reasons.join("・")}）`);
    }
  }
  return null;
}

async function captureFrames(payload, sender) {
  const videoId = String(payload?.videoId || "");
  const times = Array.isArray(payload?.times) ? payload.times.slice(0, 8).map(Number) : [];
  const taken = Array.isArray(payload?.taken) ? payload.taken.slice(0, 20).map(Number).filter(Number.isFinite) : [];
  if (!/^[\w-]{6,20}$/.test(videoId) || !times.length) throw new Error("動画IDと時刻を確認してください。");
  const tab = await frameTab(videoId);
  // Chrome does not decode video in hidden windows, so the work window comes forward while capturing.
  try { await chrome.windows.update(tab.windowId, { focused: true, state: "normal" }); await chrome.tabs.update(tab.id, { active: true }); } catch { /* best effort */ }
  try { return await captureInTab(tab, videoId, times, taken); }
  finally {
    const back = sender?.tab;
    if (back) try { await chrome.windows.update(back.windowId, { focused: true }); await chrome.tabs.update(back.id, { active: true }); } catch { /* best effort */ }
  }
}

async function captureInTab(tab, videoId, times, taken) {
  const [prepared] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: preparePlayer });
  if (prepared?.result?.error) throw new Error(prepared.result.error);
  const frames = [], used = [...taken];
  for (const target of times) {
    const log = [];
    const frame = await bestFrame(tab, target, used, log);
    if (frame) { used.push(frame.seconds); frames.push({ ...frame, ok: true }); }
    else frames.push({ ok: false, seconds: target, reason: `条件を満たす場面が見つかりませんでした（${log.slice(-3).join("／")}）` });
  }
  return { frames, quality: prepared.result.quality };
}
