// Offscreen document: runs MediaPipe Face Landmarker locally on candidate video frames.
import { FaceLandmarker, FilesetResolver } from "./mediapipe/vision_bundle.mjs";
import { chooseCrop, faceMetrics, frameScore, fromTile, mergeFaces, rejectReasons, TILES } from "./face-quality.js";

let landmarker = null;
async function model() {
  if (landmarker) return landmarker;
  const files = await FilesetResolver.forVisionTasks(chrome.runtime.getURL("mediapipe/wasm"));
  landmarker = await FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: chrome.runtime.getURL("mediapipe/face_landmarker.task"), delegate: "CPU" },
    runningMode: "IMAGE",
    numFaces: 6,
    minFaceDetectionConfidence: 0.5,
    outputFaceBlendshapes: true,
  });
  return landmarker;
}

async function load(dataUrl) {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  return image;
}

// Detect on the whole frame and on enlarged tiles; merge duplicates.
function detectFaces(detector, image) {
  const W = image.naturalWidth, H = image.naturalHeight, faces = [];
  for (const tile of TILES) {
    let source = image;
    if (tile.w < 1) {
      const sw = Math.round(tile.w * W), sh = Math.round(tile.h * H), scale = Math.min(2, 1280 / sw);
      source = new OffscreenCanvas(Math.round(sw * scale), Math.round(sh * scale));
      source.getContext("2d").drawImage(image, Math.round(tile.x * W), Math.round(tile.y * H), sw, sh, 0, 0, source.width, source.height);
    }
    const detected = detector.detect(source);
    (detected.faceLandmarks || []).forEach((landmarks, i) => faces.push(faceMetrics(fromTile(landmarks, tile), detected.faceBlendshapes?.[i]?.categories || [])));
  }
  return mergeFaces(faces);
}

// Laplacian variance inside a normalised box: how sharp (not motion-blurred) the face is.
function sharpness(image, box) {
  const W = image.naturalWidth, H = image.naturalHeight;
  const x = Math.max(0, Math.floor(box.x0 * W)), y = Math.max(0, Math.floor(box.y0 * H));
  const w = Math.max(3, Math.min(W - x, Math.ceil((box.x1 - box.x0) * W))), h = Math.max(3, Math.min(H - y, Math.ceil((box.y1 - box.y0) * H)));
  const canvas = new OffscreenCanvas(w, h), context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, x, y, w, h, 0, 0, w, h);
  const data = context.getImageData(0, 0, w, h).data, gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 0.3 * data[i * 4] + 0.59 * data[i * 4 + 1] + 0.11 * data[i * 4 + 2];
  let sum = 0, sq = 0, n = 0;
  for (let yy = 1; yy < h - 1; yy++) for (let xx = 1; xx < w - 1; xx++) {
    const i = yy * w + xx, value = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
    sum += value; sq += value * value; n++;
  }
  const mean = sum / Math.max(1, n);
  return sq / Math.max(1, n) - mean * mean;
}

export async function analyze({ frames, minHeight, bands }) {
  const detector = await model();
  const results = [];
  for (const frame of frames) {
    const image = await load(frame.dataUrl);
    const faces = detectFaces(detector, image);
    const crop = faces.length ? chooseCrop(faces, { minHeight, ...(bands || {}) }) : null;
    const reasons = rejectReasons(faces, crop);
    const main = faces.reduce((a, b) => (!a || b.height > a.height ? b : a), null);
    results.push({ time: frame.time, faces: faces.length, reasons, crop: crop?.crop || null, faceSharpness: main ? sharpness(image, main.box) : 0, faces_: faces, cropScore: crop, debug: faces.map(face => ({ h: +face.height.toFixed(3), blink: +face.blink.toFixed(2), frontal: +face.frontal.toFixed(2), headTop: +face.head.y0.toFixed(2), cx: +face.center.x.toFixed(2) })) });
  }
  const bestSharpness = Math.max(0, ...results.map(result => result.faceSharpness));
  return results.map(result => ({
    time: result.time,
    faces: result.faces,
    reasons: result.reasons,
    crop: result.crop,
    debug: result.debug,
    score: result.reasons.length ? -1 : frameScore(result.faces_, result.cropScore, result.faceSharpness, bestSharpness),
  }));
}

// A finished crop is checked again: every visible head inside with a margin, eyes open.
export async function verify({ dataUrl }) {
  const detector = await model();
  const faces = detectFaces(detector, await load(dataUrl));
  const whole = { crop: { x0: 0, y0: 0, x1: 1, y1: 1 }, score: 0 };
  const reasons = rejectReasons(faces, whole);
  const cut = faces.filter(face => face.height >= 0.1 && (face.head.y0 < -0.01 || face.head.x0 < -0.01 || face.head.x1 > 1.01 || face.box.y1 > 1));
  if (cut.length) reasons.push("切り抜き後に頭部が見切れている");
  return { ok: !reasons.length, reasons };
}

globalThis.chrome?.runtime?.onMessage?.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message?.target !== "frame-analyser") return;
  const task = message.type === "VERIFY" ? verify(message) : analyze(message);
  task.then(value => reply({ value }), error => reply({ error: String(error?.message || error) }));
  return true;
});
