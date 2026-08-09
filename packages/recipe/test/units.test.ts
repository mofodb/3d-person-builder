import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cmToFeetInches,
  feetInchesToCm,
  formatHeight,
  formatHeightBoth,
  formatMass,
  kgToPounds,
  parseHeightToCm,
  parseMassToKg,
  poundsToKg,
} from "../src/units.ts";

test("feet/inches round-trips through centimetres", () => {
  for (let totalInches = 48; totalInches <= 90; totalInches++) {
    const cm = feetInchesToCm(0, totalInches);
    const { feet, inches } = cmToFeetInches(cm);
    assert.equal(feet * 12 + inches, totalInches);
  }
});

test("cmToFeetInches never reports 12 inches", () => {
  for (let cm = 120; cm <= 250; cm += 0.25) {
    assert.ok(cmToFeetInches(cm).inches < 12, `failed at ${cm} cm`);
  }
});

test("the intended cast converts exactly", () => {
  // 4'11" and 6'8" are the shortest and tallest characters planned.
  assert.ok(Math.abs(feetInchesToCm(4, 11) - 149.86) < 0.01);
  assert.ok(Math.abs(feetInchesToCm(6, 8) - 203.2) < 0.01);
  assert.ok(Math.abs(poundsToKg(95) - 43.09) < 0.01);
  assert.ok(Math.abs(poundsToKg(265) - 120.2) < 0.01);
});

test("pounds round-trip through kilograms", () => {
  for (const lb of [95, 130, 165, 200, 265]) {
    assert.ok(Math.abs(kgToPounds(poundsToKg(lb)) - lb) < 1e-9);
  }
});

test("formats in both unit systems", () => {
  assert.equal(formatHeight(203.2, "imperial"), "6'8\"");
  assert.equal(formatHeight(175, "metric"), "175 cm");
  assert.equal(formatMass(120.2, "imperial"), "265 lb");
  assert.equal(formatMass(72, "metric"), "72 kg");
  assert.equal(formatHeightBoth(175), "175 cm (5'9\")");
});

test("parses the height formats a user might type", () => {
  const expectations: Array<[string, number]> = [
    ["203.2", 203.2],
    ["203.2cm", 203.2],
    ["203 cm", 203],
    ["2.032m", 203.2],
    ["6'8\"", 203.2],
    ["6' 8", 203.2],
    ["6ft8in", 203.2],
    ["6 feet 8 inches", 203.2],
    ["6'", 182.88],
    ["80in", 203.2],
    ["80\"", 203.2],
    ["4'11\"", 149.86],
  ];
  for (const [input, expected] of expectations) {
    const actual = parseHeightToCm(input);
    assert.ok(actual !== null, `failed to parse ${input}`);
    assert.ok(Math.abs(actual - expected) < 0.01, `${input} -> ${actual}, want ${expected}`);
  }
});

test("a bare small number is read as metres", () => {
  assert.equal(parseHeightToCm("1.78"), 178);
});

test("a bare number honours the assumed unit system", () => {
  assert.equal(parseHeightToCm("70", "metric"), 70);
  assert.ok(Math.abs(parseHeightToCm("70", "imperial")! - 177.8) < 0.01);
});

test("parses the mass formats a user might type", () => {
  const expectations: Array<[string, number]> = [
    ["72", 72],
    ["72kg", 72],
    ["72 kilograms", 72],
    ["265lb", 120.2],
    ["265 lbs", 120.2],
    ["95 pounds", 43.09],
    ["11st 4", 71.67],
  ];
  for (const [input, expected] of expectations) {
    const actual = parseMassToKg(input);
    assert.ok(actual !== null, `failed to parse ${input}`);
    assert.ok(Math.abs(actual - expected) < 0.01, `${input} -> ${actual}, want ${expected}`);
  }
});

test("unparseable input returns null rather than NaN", () => {
  for (const garbage of ["", "  ", "tall", "abc", "6'8\" or so", "kg"]) {
    assert.equal(parseHeightToCm(garbage), null, `height: ${garbage}`);
    assert.equal(parseMassToKg(garbage), null, `mass: ${garbage}`);
  }
});
