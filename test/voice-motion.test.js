import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  absorbOpacity, absorbTarget, cubicBezier, easeLeave, easeMorph, FRAME_MS, lerpBounds,
  LEAVE_MS, morphTarget, MORPH_MS, MIN_FRAME, ORB_INSET_X, PANEL_EASE,
} from '../native/motion.mjs';

const sample = (ease, points) => points.map(t => Number(ease(t).toFixed(4)));

test('a CSS cubic-bezier is a bounded, monotone time->progress function', () => {
  for (const ease of [easeMorph, easeLeave]) {
    assert.equal(ease(0), 0);
    assert.equal(ease(1), 1);
    let previous = 0;
    for (let step = 1; step <= 400; step++) {
      const value = ease(step / 400);
      assert.ok(value >= previous - 1e-9, `monotone at ${step / 400}`);
      assert.ok(value >= 0 && value <= 1);
      previous = value;
    }
  }
  const linear = cubicBezier('cubic-bezier(0, 0, 1, 1)');
  assert.deepEqual(sample(linear, [0.25, 0.5, 0.75]), [0.25, 0.5, 0.75]);
  // Out-of-range input is clamped instead of throwing into the frame loop.
  assert.equal(easeMorph(-2), 0);
  assert.equal(easeMorph(4), 1);
  assert.equal(easeMorph(Number.NaN), 0);
  assert.throws(() => cubicBezier('ease-in'), RangeError);
  assert.throws(() => cubicBezier('cubic-bezier(a, b, c, d)'), RangeError);
});

test('the density morph decelerates into the new size; the exit accelerates into the orb', () => {
  // Landing softly is the whole point: most of the travel happens early, then it settles.
  assert.ok(easeMorph(0.25) > 0.5);
  assert.ok(easeMorph(0.5) > 0.8);
  // Being pulled: the panel must still be moving fastest when it leaves.
  assert.ok(easeLeave(0.5) < 0.35);
  assert.ok(easeLeave(0.75) < 0.75);
});

test('frames interpolate edge-to-edge without shearing or collapsing below the floor', () => {
  const from = { x: 240, y: 144, width: 460, height: 124 };
  const to = { x: 160, y: 106, width: 620, height: 200 };
  assert.deepEqual(lerpBounds(from, to, 0), from);
  assert.deepEqual(lerpBounds(from, to, 1), to);
  const middle = lerpBounds(from, to, 0.5);
  assert.equal(middle.width, 540);
  assert.equal(middle.height, 162);
  assert.equal(middle.x, 200);
  assert.equal(middle.y, 125);
  // A progress outside 0..1 (or NaN) can never invert the frame.
  assert.deepEqual(lerpBounds(from, to, 9), to);
  assert.deepEqual(lerpBounds(from, to, -9), from);
  const tiny = lerpBounds({ x: 0, y: 0, width: MIN_FRAME, height: MIN_FRAME }, { x: 0, y: 0, width: 0, height: 0 }, 1);
  assert.equal(tiny.width, MIN_FRAME);
  assert.equal(tiny.height, MIN_FRAME);
});

test('a density morph keeps the panel centred and never grows up under the menu bar', () => {
  const bounds = { x: 240, y: 144, width: 460, height: 124 };
  const target = morphTarget(bounds, { width: 620, height: 200 }, { y: 25, height: 900 });
  assert.equal(target.width, 620);
  assert.equal(target.height, 200);
  assert.equal(target.x, 160);
  assert.equal(target.x + target.width / 2, bounds.x + bounds.width / 2);
  assert.equal(target.y, 106);
  assert.equal(target.y + target.height / 2, bounds.y + bounds.height / 2);
  // Near the top of the work area the top edge is held below the menu bar instead.
  const clamped = morphTarget({ x: 240, y: 30, width: 460, height: 124 }, { width: 620, height: 200 }, { y: 25, height: 900 });
  assert.equal(clamped.y, 33);
});

test('the exit collapses towards the orb, so the far edge travels and the near edge barely moves', () => {
  const bounds = { x: 100, y: 100, width: 620, height: 200 };
  const target = absorbTarget(bounds);
  assert.ok(target.width < bounds.width / 4);
  assert.ok(target.height < bounds.height / 4);
  const near = Math.abs(target.x - bounds.x);
  const far = Math.abs((bounds.x + bounds.width) - (target.x + target.width));
  assert.ok(far > near * 4, 'the far side must do most of the travelling');
  // The orb itself stays put: it is the anchor, not part of what moves.
  assert.equal(Math.round(target.y + target.height / 2), bounds.y + bounds.height / 2);
  assert.ok(Math.abs((target.x + ORB_INSET_X * 0.14) - (bounds.x + ORB_INSET_X)) <= 1);
  // Degenerate frames keep a visible, positive size.
  for (const width of [1, 40, 120]) {
    const small = absorbTarget({ x: 0, y: 0, width, height: 40 });
    assert.ok(small.width > 0 && small.height > 0);
    assert.ok(Number.isFinite(small.x) && Number.isFinite(small.y));
  }
});

test('the exit holds its shape, then gives opacity up on the way in', () => {
  assert.equal(absorbOpacity(0), 1);
  assert.equal(absorbOpacity(0.42), 1);
  assert.equal(absorbOpacity(1), 0);
  let previous = 1;
  for (const elapsed of [0.42, 0.55, 0.7, 0.85, 1]) {
    const value = absorbOpacity(elapsed);
    assert.ok(value <= previous + 1e-9);
    previous = value;
  }
  // Halfway through the visible collapse the panel is still clearly present.
  assert.ok(absorbOpacity(0.6) > 0.85);
});

test('the native frame and the page interior cannot drift apart', async () => {
  const [css, panel, main] = await Promise.all([
    readFile(new URL('../voice-ui/panel.css', import.meta.url), 'utf8'),
    readFile(new URL('../voice-ui/panel.js', import.meta.url), 'utf8'),
    readFile(new URL('../native/main.mjs', import.meta.url), 'utf8'),
  ]);
  const curve = css.match(/--voice-ease:\s*(cubic-bezier\([^)]*\))/u)?.[1];
  assert.equal(curve, PANEL_EASE, 'the native morph must use the panel easing token');
  const duration = css.match(/--voice-morph-ms:\s*(\d+)ms/u)?.[1];
  assert.equal(Number(duration), MORPH_MS, 'frame and interior must share one duration');
  // Every density-driven property is transitioned; nothing may snap to its new metrics.
  for (const property of ['padding', 'column-gap', 'gap', 'max-height', 'width', 'height']) {
    assert.match(css, new RegExp(`transition:[^;]*${property}[^;]*var\\(--voice-morph-ms\\)`, 'u'), property);
  }
  // Density is the Host phase, not the viewport: a viewport breakpoint would re-flow the
  // interior halfway through the native growth.
  const densityBlock = panel.slice(panel.indexOf('function render()'), panel.indexOf('function render()') + 1200);
  assert.match(densityBlock, /panelDensity\(host\.phase\)/u);
  // A conversation owns the tall shape for its whole life, including the next turn.
  assert.match(densityBlock, /host\.turns\.length >= 2 \? 'full'/u);
  const densityLine = densityBlock.split('\n').find(line => line.includes('panel.dataset.density =')) || '';
  assert.doesNotMatch(densityLine, /innerWidth|innerHeight|clientHeight|matchMedia/u);
  assert.doesNotMatch(css, /@media\s*\(max-height/u);
  // The exit scales the card by the factor the frame lost, measured per frame.
  assert.match(panel, /window\.innerWidth \/ width/u);
  assert.match(css, /transform: scale\(var\(--voice-leave-scale/u);
  // The helper animates the frame itself; it must never take the AppKit one-shot path.
  assert.match(main, /duration: MORPH_MS/u);
  assert.doesNotMatch(main, /setBounds\([^)]*,\s*true\)/u);
  assert.ok(LEAVE_MS >= 180 && LEAVE_MS <= 400);
  assert.ok(FRAME_MS <= 16);
});
