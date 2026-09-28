import test from "node:test";
import assert from "node:assert/strict";
import { BANDS, chooseCrop, faceMetrics, frameScore, mergeFaces, rejectReasons } from "../pc-browser-extension/face-quality.js";

// A synthetic face mesh: a box of landmarks plus nose / eye corners at the given positions.
function face({ x, y, w, h, yaw = 1, blink = 0.05 }) {
  const points = [];
  for (let i = 0; i < 478; i++) points.push({ x: x + (i % 2) * w, y: y + (Math.floor(i / 2) % 2) * h });
  points[1] = { x: x + w / 2, y: y + h * 0.6 }; // nose tip
  points[33] = { x: x + w * 0.5 - w * 0.3, y: y + h * 0.4 };
  points[263] = { x: x + w * 0.5 + w * 0.3 * yaw, y: y + h * 0.4 };
  return faceMetrics(points, [{ categoryName: "eyeBlinkLeft", score: blink }, { categoryName: "eyeBlinkRight", score: blink }]);
}

test("the crop keeps the whole head (with hair) inside and stays between the caption bands", () => {
  const person = face({ x: 0.45, y: 0.35, w: 0.1, h: 0.18 });
  const result = chooseCrop([person], { minHeight: 0.45 });
  assert.ok(result);
  const { crop } = result;
  assert.ok(crop.y0 >= BANDS.top - 1e-9 && crop.y1 <= BANDS.bottom + 1e-9);
  assert.ok(person.head.y0 >= crop.y0 && person.head.y1 <= crop.y1 && person.head.x0 >= crop.x0 && person.head.x1 <= crop.x1);
  assert.deepEqual(rejectReasons([person], result), []);
});

test("a close-up whose head reaches the caption band is rejected instead of being cut", () => {
  const closeUp = face({ x: 0.35, y: 0.12, w: 0.2, h: 0.35 });
  const result = chooseCrop([closeUp], { minHeight: 0.45 });
  assert.equal(result, null);
  assert.match(rejectReasons([closeUp], result).join(), /見切れる/);
});

test("people are never cut in half: each face is fully in or fully out", () => {
  const main = face({ x: 0.3, y: 0.35, w: 0.1, h: 0.18 });
  const side = face({ x: 0.62, y: 0.38, w: 0.08, h: 0.15 });
  const result = chooseCrop([main, side], { minHeight: 0.45 });
  assert.ok(result);
  for (const person of [main, side]) {
    const inside = person.head.x0 >= result.crop.x0 && person.head.x1 <= result.crop.x1;
    const outside = person.box.x1 <= result.crop.x0 || person.box.x0 >= result.crop.x1;
    assert.ok(inside || outside);
  }
  assert.equal(result.included, 2);
});

test("closed eyes, side profiles and heads cut in the original shot are rejected", () => {
  const ok = face({ x: 0.45, y: 0.35, w: 0.1, h: 0.18 });
  const crop = chooseCrop([ok], { minHeight: 0.45 });
  assert.match(rejectReasons([face({ x: 0.45, y: 0.35, w: 0.1, h: 0.18, blink: 0.6 })], crop).join(), /目を閉じ/);
  assert.match(rejectReasons([face({ x: 0.45, y: 0.35, w: 0.1, h: 0.18, yaw: 0.1 })], crop).join(), /横顔/);
  assert.match(rejectReasons([], null).join(), /顔が写っていない/);
});

test("sharper and more frontal frames rank higher; duplicate detections merge", () => {
  const person = face({ x: 0.45, y: 0.35, w: 0.1, h: 0.18 });
  const crop = chooseCrop([person], { minHeight: 0.45 });
  assert.ok(frameScore([person], crop, 100, 100) > frameScore([person], crop, 40, 100));
  const turned = face({ x: 0.45, y: 0.35, w: 0.1, h: 0.18, yaw: 0.5 });
  assert.ok(frameScore([person], crop, 100, 100) > frameScore([turned], crop, 100, 100));
  assert.equal(mergeFaces([person, face({ x: 0.46, y: 0.36, w: 0.08, h: 0.15 })]).length, 1);
});
