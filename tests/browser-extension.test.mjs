import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const script = readFileSync(new URL("../pc-browser-extension/background.js", import.meta.url), "utf8");
const origin = "https://video-primary-article-studio.k-innovationx.workers.dev";

// A fake Chrome whose assistant tab answers each sent prompt after a few reads.
function harness() {
  const db = {};
  let listener, opened = 0, now = 1_000_000;
  const page = { url: "https://claude.ai/new", status: "complete", replies: 0, sent: [], busy: false, failSend: false, image: false, ready: true, alreadySent: false };
  const clone = (value) => (value === undefined ? undefined : structuredClone(value));
  const chrome = {
    runtime: { getManifest: () => ({ version: "0.2.0" }), onMessage: { addListener: (fn) => (listener = fn) } },
    storage: { local: {
      get: async (key) => (key === null ? clone(db) : { [key]: clone(db[key]) }),
      set: async (obj) => Object.assign(db, clone(obj)),
      remove: async (keys) => keys.forEach((key) => delete db[key]),
    } },
    windows: { get: async () => ({}), create: async () => ({ id: 7 }), update: async () => ({}) },
    tabs: {
      create: async () => ({ id: ++opened, windowId: 7 }),
      get: async (id) => ({ id, url: page.url, status: page.status, windowId: 7 }),
      update: async () => ({}),
      query: async () => [],
      sendMessage: async (_id, message) => {
        if (message.action === "PROBE") return { ready: page.ready };
        if (message.action === "SEND") {
          if (page.failSend) throw new Error("reply lost");
          page.sent.push(message.prompt);
          page.replies++;
          return { ok: true, baseCount: page.replies - 1 };
        }
        if (message.action === "READ" && message.baseCount === 0 && message.promptHead && page.alreadySent) return { sent: true, hasReply: true, count: 1, busy: false, text: "既存の回答", html: "<p>既存の回答</p>", imageKeys: [], artifact: false, loginRequired: false };
        if (message.action === "READ") return { count: page.replies, busy: page.busy, text: `回答${page.replies}`, html: `<p>回答${page.replies}</p>`, imageKeys: page.image ? ["1024x576:x"] : [], artifact: false, loginRequired: false };
        if (message.action === "IMAGE") return { dataUrl: "data:image/png;base64,AAAA" };
      },
    },
    scripting: { executeScript: async () => [{ result: "visible report text ".repeat(5) }] },
  };
  const clock = { now: () => now };
  const FakeDate = class extends Date { static now() { return clock.now(); } };
  vm.runInNewContext(script, { chrome, URL, Date: FakeDate, Promise, Set, Error, String, Number, Object, Array, JSON, setTimeout, btoa, fetch });
  const call = (command, payload, from = origin) => new Promise((resolve) => {
    const accepted = listener({ command, payload }, { tab: { id: 999, windowId: 1 }, origin: from, frameId: 0 }, resolve);
    if (!accepted) resolve(null);
  });
  return { call, db, page, opened: () => opened, advance: (ms) => (now += ms) };
}
const job = { id: "test-request-0001", provider: "claude", steps: [{ prompt: "資料" }, { prompt: "記事1" }, { prompt: "記事2" }] };

test("double click with the same id opens only one conversation", async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.call("RUN", job), h.call("RUN", job)]);
  assert.equal(h.opened(), 1);
  assert.equal(a.value.id, b.value.id);
});

test("untrusted origin cannot run anything", async () => {
  const h = harness();
  assert.equal(await h.call("RUN", job, "https://example.com"), null);
  assert.equal(h.opened(), 0);
});

test("steps are sent one after another only when the previous answer settles", async () => {
  const h = harness();
  await h.call("RUN", job);
  let status = (await h.call("STATUS", { id: job.id })).value;
  assert.equal(status.state, "waiting");
  assert.deepEqual(h.page.sent, ["資料"]);
  status = (await h.call("STATUS", { id: job.id })).value; // not yet settled
  assert.deepEqual(h.page.sent, ["資料"]);
  for (let i = 0; i < 3; i++) {
    h.advance(7000); await h.call("STATUS", { id: job.id }); // stable long enough → store result
    if (i < 2) { await h.call("STATUS", { id: job.id }); await h.call("STATUS", { id: job.id }); } // send next, first read
  }
  status = (await h.call("STATUS", { id: job.id })).value;
  assert.deepEqual(h.page.sent, ["資料", "記事1", "記事2"]);
  assert.equal(status.state, "review");
  assert.equal((await h.call("RESULT", { id: job.id, step: 2 })).value.html, "<p>回答3</p>");
});

test("busy answers are never treated as finished", async () => {
  const h = harness();
  await h.call("RUN", job);
  await h.call("STATUS", { id: job.id });
  h.page.busy = true;
  h.advance(60000);
  const status = (await h.call("STATUS", { id: job.id })).value;
  assert.equal(status.state, "waiting");
  assert.deepEqual(h.page.sent, ["資料"]);
});

test("lost SEND reply stops for review instead of re-sending", async () => {
  const h = harness();
  await h.call("RUN", job);
  h.page.failSend = true;
  const status = (await h.call("STATUS", { id: job.id })).value;
  assert.equal(status.state, "attention");
  await h.call("STATUS", { id: job.id });
  assert.equal(h.page.sent.length, 0);
});

test("image steps capture the generated image", async () => {
  const h = harness();
  h.page.url = "https://chatgpt.com/";
  h.page.image = true;
  const imageJob = { id: "image-request-0001", provider: "gpt", steps: [{ prompt: "画像1", expectImage: true, attachments: [{ name: "r.jpg", dataUrl: "data:image/jpeg;base64,AAAA" }] }] };
  await h.call("RUN", imageJob);
  await h.call("STATUS", { id: imageJob.id });
  await h.call("STATUS", { id: imageJob.id });
  h.advance(9000);
  const status = (await h.call("STATUS", { id: imageJob.id })).value;
  assert.equal(status.state, "review");
  assert.equal(status.results[0].imageCount, 1);
  assert.match((await h.call("IMAGE", { id: imageJob.id, step: 0 })).value.dataUrl, /^data:image\/png/);
});

test("changed tab origin blocks execution", async () => {
  const h = harness();
  await h.call("RUN", job);
  h.page.url = "https://example.com/";
  const status = (await h.call("STATUS", { id: job.id })).value;
  assert.equal(status.state, "attention");
  assert.equal(h.page.sent.length, 0);
});

test("invalid or oversized requests never open a tab", async () => {
  const h = harness();
  assert.ok((await h.call("RUN", { ...job, steps: [{ prompt: "a".repeat(150001) }] })).error);
  assert.ok((await h.call("RUN", { ...job, steps: [{ prompt: "x", attachments: [{ dataUrl: "javascript:alert(1)" }] }] })).error);
  assert.equal(h.opened(), 0);
});

test("manifest keeps a narrow permission set", () => {
  const manifest = JSON.parse(readFileSync(new URL("../pc-browser-extension/manifest.json", import.meta.url)));
  assert.deepEqual(manifest.permissions, ["storage", "unlimitedStorage", "scripting", "offscreen"]);
  assert.ok(!manifest.host_permissions.some((host) => /<all_urls>|\*:\/\/\*\//.test(host)));
  for (const file of ["background.js", "assistant-page.js", "studio-bridge.js"]) {
    const code = readFileSync(new URL(`../pc-browser-extension/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(code, /chrome\.cookies|api\.anthropic|api\.openai|wp-json/);
  }
  assert.ok(manifest.host_permissions.includes("https://www.youtube.com/*"));
  {
  }
});

test("a step already sent in a long (virtualised) conversation is followed, not re-sent", async () => {
  const h = harness();
  h.page.alreadySent = true;
  await h.call("RUN", job);
  const status = (await h.call("STATUS", { id: job.id })).value;
  assert.equal(status.state, "waiting");
  assert.equal(h.page.sent.length, 0);
});
