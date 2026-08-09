import assert from "node:assert/strict";
import { test } from "node:test";

import { computeSkinColor, hexToRgb, sampleSkinToneRamp } from "../src/skin.ts";

test("ramp endpoints and midpoint stay within 0..1", () => {
  for (const tone of [0, 0.25, 0.5, 0.75, 1]) {
    const color = sampleSkinToneRamp(tone);
    for (const channel of [color.r, color.g, color.b]) {
      assert.ok(channel >= 0 && channel <= 1, `tone=${tone} channel=${channel}`);
    }
  }
});

test("the ramp gets monotonically darker", () => {
  let previous = sampleSkinToneRamp(0);
  for (let i = 1; i <= 20; i++) {
    const color = sampleSkinToneRamp(i / 20);
    const luminance = (c: { r: number; g: number; b: number }) => c.r + c.g + c.b;
    assert.ok(luminance(color) <= luminance(previous) + 1e-9, `darkened at step ${i}`);
    previous = color;
  }
});

test("out-of-range tone is clamped rather than throwing", () => {
  assert.deepEqual(sampleSkinToneRamp(-1), sampleSkinToneRamp(0));
  assert.deepEqual(sampleSkinToneRamp(2), sampleSkinToneRamp(1));
});

test("hexToRgb parses with and without a leading #", () => {
  assert.deepEqual(hexToRgb("#ffffff"), { r: 1, g: 1, b: 1 });
  assert.deepEqual(hexToRgb("000000"), { r: 0, g: 0, b: 0 });
});

test("hexToRgb rejects malformed input", () => {
  assert.throws(() => hexToRgb("not-a-color"));
});

test("a white tint is the identity: skin color equals the raw ramp sample", () => {
  const ramp = sampleSkinToneRamp(0.4);
  const skin = computeSkinColor({ tone: 0.4, tint: "#ffffff", roughness: 0.5, overlays: [] });
  assert.ok(Math.abs(skin.r - ramp.r) < 1e-9);
  assert.ok(Math.abs(skin.g - ramp.g) < 1e-9);
  assert.ok(Math.abs(skin.b - ramp.b) < 1e-9);
});

test("a tint multiplies the ramp sample", () => {
  const skin = computeSkinColor({ tone: 0.4, tint: "#808080", roughness: 0.5, overlays: [] });
  const ramp = sampleSkinToneRamp(0.4);
  assert.ok(Math.abs(skin.r - ramp.r * (0x80 / 255)) < 1e-6);
});
