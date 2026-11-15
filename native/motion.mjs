// Pure motion geometry for the owned panel. No Electron, no timers, no window objects:
// main.mjs owns the clock and the frame writes, this module owns only the shape of the
// motion, so the curve and the anchoring can be tested without a GUI.
//
// PANEL_EASE is the panel's own --voice-ease and MORPH_MS is --voice-morph-ms in
// voice-ui/panel.css. The interior morphs its metrics on that exact curve while the native
// frame interpolates here, which is what keeps the glass and its content together instead
// of one arriving before the other. A test pins both copies to each other.

/** Deceleration into the new size. Same curve as every other transition in the panel
 *  (voice-ui/panel.css --voice-ease), so the whole surface moves as one system. */
export const PANEL_EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)';
/** Acceleration into the orb: the panel is pulled, so it leaves faster than it arrives. */
export const LEAVE_EASE = 'cubic-bezier(0.45, 0.1, 0.7, 0.45)';
export const MORPH_MS = 320;
export const LEAVE_MS = 240;
export const FRAME_MS = 8;
/** Orb centre inside the full panel: 15px padding + half of the 74px orb. */
export const ORB_INSET_X = 15 + 37;
export const LEAVE_SCALE = 0.14;
export const MIN_FRAME = 24;

export const clamp01 = value => Math.max(0, Math.min(1, value));

/** CSS cubic-bezier(x1, y1, x2, y2) as an easing function of linear time. */
export function cubicBezier(source) {
  const [x1, y1, x2, y2] = String(source).slice(String(source).indexOf('(') + 1, -1).split(',').map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite)) throw new RangeError('Expected a CSS cubic-bezier()');
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sample = (a, b, c, u) => ((a * u + b) * u + c) * u;
  const slope = u => (3 * ax * u + 2 * bx) * u + cx;
  return value => {
    const target = clamp01(Number.isFinite(value) ? value : 0);
    let u = target;
    for (let step = 0; step < 6; step++) {
      const error = sample(ax, bx, cx, u) - target;
      if (Math.abs(error) < 1e-5) break;
      const derivative = slope(u);
      if (Math.abs(derivative) < 1e-5) break;
      u = clamp01(u - error / derivative);
    }
    return sample(ay, by, cy, u);
  };
}

export const easeMorph = cubicBezier(PANEL_EASE);
export const easeLeave = cubicBezier(LEAVE_EASE);

/** Interpolate a window frame. Both edges move together, so a morph never shears. */
export function lerpBounds(from, to, progress) {
  const k = clamp01(progress);
  return {
    x: Math.round(from.x + (to.x - from.x) * k),
    y: Math.round(from.y + (to.y - from.y) * k),
    width: Math.max(MIN_FRAME, Math.round(from.width + (to.width - from.width) * k)),
    height: Math.max(MIN_FRAME, Math.round(from.height + (to.height - from.height) * k)),
  };
}

/**
 * The frame a panel of `size` should occupy in place of `bounds`: same centre, so the
 * panel breathes in and out instead of sliding away from where the user last saw it.
 * `workArea` only keeps the top edge from growing up under the menu bar.
 */
export function morphTarget(bounds, size, workArea = null) {
  const centreX = bounds.x + bounds.width / 2;
  const centreY = bounds.y + bounds.height / 2;
  const floor = workArea ? workArea.y + 8 : -Infinity;
  return {
    x: Math.round(centreX - size.width / 2),
    y: Math.max(floor, Math.round(centreY - size.height / 2)),
    width: size.width,
    height: size.height,
  };
}

/**
 * The frame the panel collapses into on exit. The orb is the anchor: it sits
 * ORB_INSET_X from the left edge and vertically centred, so the far side of the card
 * travels most of its own width while the near side barely moves. That difference is
 * what reads as suction rather than as a plain scale.
 */
export function absorbTarget(bounds) {
  const inset = Math.min(ORB_INSET_X, bounds.width / 2);
  const anchorX = bounds.x + inset, anchorY = bounds.y + bounds.height / 2;
  return {
    x: Math.round(anchorX - inset * LEAVE_SCALE),
    y: Math.round(anchorY - (bounds.height * LEAVE_SCALE) / 2),
    width: Math.max(48, Math.round(bounds.width * LEAVE_SCALE)),
    height: Math.max(28, Math.round(bounds.height * LEAVE_SCALE)),
  };
}

/**
 * Opacity over the exit: hold the shape while it is still recognisable, then give it up
 * quickly on the way in, reaching zero exactly when the frame reaches the orb.
 */
export function absorbOpacity(elapsed) {
  return 1 - clamp01((elapsed - 0.42) / 0.58) ** 2;
}
