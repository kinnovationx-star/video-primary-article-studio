import { mkdirSync, mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
const temp = mkdtempSync(join(tmpdir(), "video-studio-extension-"));
const archive = join(temp, "video-studio-extension.zip");
// Explicit allowlist: no keys, browser data, user materials or unrelated files.
execFileSync("zip", ["-X", archive, "manifest.json", "background.js", "assistant-page.js", "studio-bridge.js", "offscreen.html", "offscreen.js", "face-quality.js", "README.md", "mediapipe/NOTICE.md", "mediapipe/vision_bundle.mjs", "mediapipe/face_landmarker.task", "mediapipe/wasm/vision_wasm_internal.js", "mediapipe/wasm/vision_wasm_internal.wasm"], { cwd: resolve("pc-browser-extension") });
mkdirSync("public/downloads", { recursive: true });
copyFileSync(archive, "public/downloads/video-studio-extension.zip");
