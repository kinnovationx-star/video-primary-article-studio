// Frame quality rules for H2 images cut from the interview video. Pure functions (no DOM),
// shared by the offscreen analyser and the unit tests.
// All coordinates are normalised to the source frame: x by width, y by height (16:9 video).

// Burned-in graphics of the A TRUTH STORY template: chapter title / logo at the top,
// subtitles at the bottom. Crops must stay between these bands.
export const BANDS = { top: 0.165, bottom: 0.845 };
export const LIMITS = {
  subjectMinHeight: 0.07, // smaller faces are background (posters, distant people)
  blinkMax: 0.42, // eyeBlink blendshape above this = closed or half-closed eyes
  profileMinRatio: 0.3, // nose-to-eye distance ratio; lower = side profile
  jawOpenMax: 0.65, // wide open mouth mid-word
};

// MediaPipe face mesh landmark indices.
const NOSE_TIP = 1, EYE_OUTER_LEFT = 33, EYE_OUTER_RIGHT = 263;

export function faceMetrics(landmarks, blendshapes = []) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const point of landmarks) {
    x0 = Math.min(x0, point.x); x1 = Math.max(x1, point.x);
    y0 = Math.min(y0, point.y); y1 = Math.max(y1, point.y);
  }
  const fw = x1 - x0, fh = y1 - y0;
  const score = name => blendshapes.find(item => item.categoryName === name)?.score ?? 0;
  const nose = landmarks[NOSE_TIP], left = landmarks[EYE_OUTER_LEFT], right = landmarks[EYE_OUTER_RIGHT];
  const dl = nose && left ? Math.abs(nose.x - left.x) : 1, dr = nose && right ? Math.abs(right.x - nose.x) : 1;
  return {
    box: { x0, y0, x1, y1 },
    // The mesh stops at the hairline: leave room for hair above and the neck below.
    head: { x0: x0 - fw * 0.28, y0: y0 - fh * 0.5, x1: x1 + fw * 0.28, y1: y1 + fh * 0.25 },
    height: fh,
    center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
    blink: Math.max(score("eyeBlinkLeft"), score("eyeBlinkRight")),
    jawOpen: score("jawOpen"),
    frontal: Math.min(dl, dr) / Math.max(dl, dr, 1e-6),
  };
}

const inside = (inner, outer) => inner.x0 >= outer.x0 && inner.x1 <= outer.x1 && inner.y0 >= outer.y0 && inner.y1 <= outer.y1;
const overlaps = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

// Best 16:9 crop that keeps every chosen head fully inside, cuts no head partially,
// and stays between the caption bands. Returns null when no such crop exists.
export function chooseCrop(faces, { minHeight = 0.45, top = BANDS.top, bottom = BANDS.bottom, maxHeight = bottom - top, aspect = 1 } = {}) {
  const subjects = faces.filter(face => face.height >= LIMITS.subjectMinHeight);
  if (!subjects.length) return null;
  const main = subjects.reduce((a, b) => (b.height > a.height ? b : a));
  let best = null;
  for (let h = Math.min(maxHeight, bottom - top); h >= minHeight - 1e-9; h -= 0.02) {
    const w = h * aspect;
    for (let y = top; y + h <= bottom + 1e-9; y += 0.01) {
      for (let x = 0; x + w <= 1 + 1e-9; x += 0.01) {
        const crop = { x0: x, y0: y, x1: x + w, y1: y + h };
        if (!inside(main.head, crop)) continue;
        let included = 0, valid = true;
        for (const face of faces) {
          if (inside(face.head, crop)) { included += face.height >= LIMITS.subjectMinHeight ? 1 : 0; continue; }
          // A face may be left out only if no part of it (not even the hair) shows at the edge.
          if (overlaps(face.box, crop)) { valid = false; break; }
        }
        if (!valid) continue;
        const headroom = (main.head.y0 - y) / h; // space above the main head, as a share of the crop
        const offset = Math.abs((main.center.x - x) / w - 0.5);
        const score = included * 10 + h * 8 - Math.abs(headroom - 0.06) * 12 - offset * 6;
        if (!best || score > best.score) best = { crop, included, score };
      }
    }
  }
  return best;
}

// Hard checks for the people shown in the crop; returns the reasons a frame is rejected.
export function rejectReasons(faces, crop) {
  const reasons = [];
  const subjects = faces.filter(face => face.height >= LIMITS.subjectMinHeight);
  if (!subjects.length) return ["人物の顔が写っていない"];
  if (!crop) return ["頭部まで16:9に収まらない（見切れる）"];
  const shown = faces.filter(face => inside(face.head, crop.crop));
  if (shown.some(face => face.blink > LIMITS.blinkMax)) reasons.push("目を閉じている・半目");
  const main = subjects.reduce((a, b) => (b.height > a.height ? b : a));
  if (main.frontal < LIMITS.profileMinRatio) reasons.push("横顔すぎる");
  if (main.jawOpen > LIMITS.jawOpenMax) reasons.push("口が大きく開いた瞬間");
  if (main.head.y0 < 0 || main.head.x0 < 0 || main.head.x1 > 1) reasons.push("元の映像で頭部が切れている");
  return reasons;
}

// Ranking among frames that passed: sharp face, eyes clearly open, facing the camera side.
export function frameScore(faces, crop, faceSharpness, bestSharpness) {
  const subjects = faces.filter(face => face.height >= LIMITS.subjectMinHeight);
  const main = subjects.reduce((a, b) => (b.height > a.height ? b : a));
  return (faceSharpness / Math.max(bestSharpness, 1e-6)) * 50 + (1 - main.blink) * 15 + main.frontal * 15 + Math.min(main.height, 0.35) * 30 + crop.score;
}

// Faces found in several overlapping tiles are the same person: keep the largest detection.
export function mergeFaces(faces) {
  const sorted = [...faces].sort((a, b) => b.height - a.height), kept = [];
  for (const face of sorted) {
    const duplicate = kept.some(other => face.center.x > other.box.x0 && face.center.x < other.box.x1 && face.center.y > other.box.y0 && face.center.y < other.box.y1);
    if (!duplicate) kept.push(face);
  }
  return kept;
}

// Landmarks detected inside a tile, mapped back to whole-frame coordinates.
export function fromTile(landmarks, tile) {
  return landmarks.map(point => ({ x: tile.x + point.x * tile.w, y: tile.y + point.y * tile.h, z: point.z }));
}

// The whole frame plus overlapping enlarged tiles, so that small faces in wide shots are found.
export const TILES = [
  { x: 0, y: 0, w: 1, h: 1 },
  { x: 0, y: 0, w: 0.5, h: 0.75 }, { x: 0.25, y: 0, w: 0.5, h: 0.75 }, { x: 0.5, y: 0, w: 0.5, h: 0.75 },
  { x: 0, y: 0.25, w: 0.5, h: 0.75 }, { x: 0.25, y: 0.25, w: 0.5, h: 0.75 }, { x: 0.5, y: 0.25, w: 0.5, h: 0.75 },
];
