// UI-only adapter for the logged-in Claude / ChatGPT pages. No cookies, credentials or API calls.
if (!globalThis.videoStudioAdapter021) {
  globalThis.videoStudioAdapter021 = true;
  const isClaude = location.hostname === "claude.ai";
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => !!el && el.getClientRects().length > 0;
  const all = selector => [...document.querySelectorAll(selector)];
  const first = selectors => {
    for (const selector of selectors) {
      const found = all(selector).find(visible);
      if (found) return found;
    }
    return null;
  };
  const editorSelectors = isClaude
    ? ['.ProseMirror[contenteditable="true"]', '[contenteditable="true"][role="textbox"]']
    : ['[data-chatgpt-composer] [contenteditable="true"]', '[data-composer-markdown][contenteditable="true"]', '#prompt-textarea', '.ProseMirror[contenteditable="true"]'];
  const sendSelectors = isClaude
    ? ['button[aria-label="メッセージを送信"]', 'button[aria-label="Send message"]', 'button[aria-label*="送信"]', 'button[aria-label*="Send"]']
    : ['form[data-chatgpt-composer] button[type="submit"]', 'button[data-testid="send-button"]', '#composer-submit-button', 'button[aria-label="送信"]', 'button[aria-label*="Send"]', 'button[aria-label*="送信"]'];
  const editor = () => first(editorSelectors);
  const editorText = el => (el?.innerText ?? el?.value ?? "");
  const compact = value => String(value).replace(/\s+/g, "");

  // One element per assistant reply, oldest first.
  function replies() {
    if (isClaude) {
      const nodes = all('[data-testid="assistant-message"]');
      return nodes.length ? nodes : all("[data-is-streaming]");
    }
    const turns = all("[data-turn-key]");
    if (turns.length) return turns;
    const roles = all('[data-conversation-role="assistant"], [data-message-author-role="assistant"]');
    return roles.length ? roles : all('article[data-testid^="conversation-turn"]');
  }
  function isBusy() {
    if (isClaude && document.querySelector('[data-is-streaming="true"]')) return true;
    const stop = all("button").find(b => visible(b) && /停止|Stop/i.test(b.getAttribute("aria-label") || "") && !/音声|voice/i.test(b.getAttribute("aria-label") || ""));
    if (stop || document.querySelector('button[data-testid="stop-button"]')) return true;
    const last = replies().at(-1);
    return !isClaude && !!last && /画像を作成しています|画像を生成しています|Creating image|Generating image/i.test(last.innerText || "") && !generatedImages(last).length;
  }
  function generatedImages(scope) {
    if (!scope) return [];
    const tagged = [...scope.querySelectorAll('[data-testid="generated-image-preview"] img, img[alt^="生成画像"], img[alt^="生成された画像"], img[alt^="Generated image"]')];
    const candidates = tagged.length ? tagged : [...scope.querySelectorAll("img")].filter(img => img.naturalWidth >= 512);
    return candidates.filter(img => !img.closest("[data-user-message-bubble]") && img.complete && img.naturalWidth >= 256);
  }
  // Long conversations are virtualised (older messages are unmounted), so replies are found
  // relative to our own last message rather than by counting.
  const head = value => compact(value).slice(0, 40);
  function replyAfter(promptHead) {
    if (!promptHead) return null;
    if (isClaude) {
      const user = all('[data-testid="user-message"]').at(-1);
      if (!user || !compact(user.innerText).includes(promptHead)) return { sent: false, reply: null };
      const reply = all('[data-testid="assistant-message"]').find(node => user.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) || null;
      return { sent: true, reply };
    }
    const bubbles = all("[data-user-message-bubble]");
    const bubble = bubbles.at(-1);
    if (!bubble || !compact(bubble.innerText).includes(promptHead)) return { sent: false, reply: null };
    const turn = bubble.closest("[data-turn-key]");
    const hasAnswer = node => !!node && (node.querySelector('[data-conversation-role="assistant"], [data-message-author-role="assistant"], [data-testid="generated-image-preview"]'));
    let reply = hasAnswer(turn) ? turn : null;
    if (!reply) reply = all("[data-turn-key], [data-conversation-role=\"assistant\"]").find(node => bubble.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING && hasAnswer(node.matches("[data-turn-key]") ? node : node.parentElement)) || null;
    return { sent: true, reply };
  }
  function answerNode(reply) {
    if (!reply) return null;
    if (isClaude) return reply.querySelector(".font-claude-response, .font-claude-message") || reply;
    return reply.querySelector('[data-conversation-role="assistant"], [data-message-author-role="assistant"]') || reply;
  }

  // Serialise the rendered answer into a small, attribute-free HTML subset.
  const keep = new Set(["P", "H1", "H2", "H3", "H4", "UL", "OL", "LI", "STRONG", "B", "EM", "I", "BLOCKQUOTE", "BR", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "A", "HR", "CODE"]);
  const drop = new Set(["BUTTON", "SVG", "SCRIPT", "STYLE", "IMG", "PICTURE", "VIDEO", "INPUT", "TEXTAREA", "SELECT", "NOSCRIPT", "IFRAME"]);
  const escapeText = value => value.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  function serialise(node) {
    if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent || "");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = node.tagName.toUpperCase();
    if (drop.has(tag) || node.getAttribute("aria-hidden") === "true") return "";
    const inner = [...node.childNodes].map(serialise).join("");
    if (!keep.has(tag)) return inner;
    const name = tag.toLowerCase();
    if (tag === "BR" || tag === "HR") return `<${name}>`;
    if (tag === "A") {
      const href = node.getAttribute("href") || "";
      return /^https?:\/\//.test(href) ? `<a href="${href.replace(/"/g, "&quot;")}">${inner}</a>` : inner;
    }
    return `<${name}>${inner}</${name}>`;
  }

  async function imageData(img) {
    try {
      const blob = await (await fetch(img.currentSrc || img.src, { credentials: "include" })).blob();
      if (blob.size > 1000 && blob.type.startsWith("image/")) {
        return await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
      }
    } catch { /* fall back to the rendered pixels */ }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);
      return canvas.toDataURL("image/png");
    } catch { return ""; }
  }

  function dataUrlFile(attachment) {
    const [head, body] = String(attachment.dataUrl).split(",");
    const type = head.match(/data:([^;]+)/)?.[1] || attachment.type || "image/png";
    const binary = atob(body || "");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], attachment.name || "reference.png", { type });
  }

  async function attach(files) {
    const transfer = new DataTransfer();
    files.forEach(file => transfer.items.add(file));
    const scope = document.querySelector("form[data-chatgpt-composer]") || document;
    const input = [...scope.querySelectorAll('input[type="file"]')].find(el => el.accept === "image/*") || [...scope.querySelectorAll('input[type="file"]')].find(el => /image/.test(el.accept)) || scope.querySelector('input[type="file"]');
    const before = scope.querySelectorAll("img").length;
    if (input) {
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      editor()?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    }
    // Wait until the previews render; uploads finish before the send button enables.
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      if (scope.querySelectorAll("img").length >= before + files.length) return true;
    }
    return false;
  }

  async function send(prompt, attachments) {
    let box = editor();
    for (let i = 0; !box && i < 20; i++) { await sleep(500); box = editor(); }
    if (!box) return { error: "入力欄が見つかりません。ログイン状態・利用上限を専用タブで確認してください。" };
    const baseCount = replies().length;
    let attachWarning = "";
    if (attachments?.length) {
      const ok = await attach(attachments.map(dataUrlFile));
      if (!ok) attachWarning = "参照画像の添付を画面で確認できませんでした。";
    }
    box.focus();
    if (compact(editorText(box)) && compact(editorText(box)) !== compact(prompt)) {
      document.execCommand("selectAll", false);
      document.execCommand("delete", false);
    }
    if (!compact(editorText(box))) {
      // Bounded chunks: one huge edit is unreliable in ProseMirror.
      for (const chunk of String(prompt).match(/[\s\S]{1,4000}/g) || []) document.execCommand("insertText", false, chunk);
    }
    await sleep(400);
    if (compact(editorText(box)) !== compact(prompt)) return { error: "依頼文を入力欄へ正しく入力できませんでした。専用タブを確認してください。" };
    let button = null;
    for (let i = 0; i < 120; i++) {
      button = first(sendSelectors);
      if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") break;
      await sleep(500);
    }
    if (!button || button.disabled) return { error: "送信ボタンが有効になりません（添付のアップロード中・利用上限の可能性）。専用タブを確認してください。" };
    button.click();
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (replies().length > baseCount || isBusy() || !compact(editorText(editor()))) return { ok: true, baseCount, attachWarning, promptHead: head(prompt) };
    }
    return { error: "送信を確認できませんでした。専用タブで送信状態を確認してください（自動再送はしていません）。" };
  }

  function read(baseCount, promptHead) {
    const list = replies();
    const found = replyAfter(promptHead);
    const reply = found ? found.reply : list.length > baseCount ? list.at(-1) : null;
    const answer = answerNode(reply);
    const images = isClaude ? [] : generatedImages(reply);
    const artifact = isClaude && !!reply?.querySelector('[class*="artifact"], [data-testid*="artifact"]');
    const loginRequired = !editor() && /ログイン|Log in|Sign up/i.test(document.body.innerText.slice(0, 3000));
    return {
      sent: found ? found.sent : true,
      hasReply: !!reply,
      count: list.length,
      busy: isBusy(),
      text: (answer?.innerText || "").slice(0, 200000),
      html: answer ? serialise(answer).slice(0, 400000) : "",
      imageKeys: images.map(img => `${img.naturalWidth}x${img.naturalHeight}:${(img.currentSrc || img.src).slice(-24)}`),
      artifact,
      loginRequired,
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.action === "PROBE") {
      const box = editor();
      reply({ ready: !!box, count: replies().length, reason: box ? "" : "入力欄が表示されていません。ログイン・利用上限・認証画面を専用タブで確認してください。" });
      return;
    }
    if (message.action === "SEND") { send(message.prompt, message.attachments).then(reply, error => reply({ error: String(error?.message || error) })); return true; }
    if (message.action === "READ") { reply(read(Number(message.baseCount) || 0, message.promptHead || "")); return; }
    if (message.action === "IMAGE") {
      const list = replies();
      const found = replyAfter(message.promptHead || "");
      const images = generatedImages(found ? found.reply : list.length > Number(message.baseCount) ? list.at(-1) : null);
      const largest = images.sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight)[0];
      if (!largest) { reply({ error: "生成画像が見つかりません。" }); return; }
      imageData(largest).then(dataUrl => reply(dataUrl ? { dataUrl, src: largest.currentSrc || largest.src } : { error: "生成画像を取得できませんでした。", src: largest.currentSrc || largest.src }));
      return true;
    }
  });
}
