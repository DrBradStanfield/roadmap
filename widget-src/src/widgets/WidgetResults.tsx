// The waist-to-height and BMI widget's results (US-74 AC3), as the page's
// calculator mock draws them: the ratio large, its grade as a coloured pill and
// a 0.35 to 0.65 scale with a marker, then BMI and the target waist.
//
// Clarity records the page's DOM: its text under the block's mask, but every
// class, style and attribute as it is (review P1). So nothing in this markup
// varies with the grade or the value: the colour-bearing parts are drawn on
// canvases, whose pixels Clarity does not record, and the numbers and words
// are text, which it masks. WaistToHeight.test.tsx checks a Healthy and an
// Elevated result give the same attributes.
import { useLayoutEffect, useRef, useState } from 'react';
import { statTileText } from '@roadmap/health-core/stat-tiles';
import type { Results } from './body-measures';

const SCALE = { min: 0.35, max: 0.65, line: 0.5 } as const;

/** Every text the result fills is one length whatever the grade or value, as Clarity encodes it. Clarity
 *  replaces masked text with its trimmed length and keeps the whitespace around it (clarity-js
 *  scrub.ts mangleText; String.prototype.trim drops every Unicode space, the no-break space too), so
 *  "Healthy" (7) and "Elevated" (8) would differ, and space padding does not hide it (Codex review
 *  1871b R1). The pad is U+2060 WORD JOINER: not whitespace, so Clarity counts it; zero width and
 *  default-ignorable, so no font draws it and screen readers skip it. Lengths: the longest of each kind
 *  ("Elevated"; "Underweight range"), a ratio ("0.47"), a BMI ("124.1") and a target ("<49.2 in"). */
const WIDTH = { grade: 8, category: 17, ratio: 4, bmi: 5, target: 8 } as const;
export const PAD = '\u2060';
export const fixed = (text: string | undefined, width: number) => (text ?? '') + PAD.repeat(Math.max(0, width - (text ?? '').length));
const GREEN = '#0B6B54';
const MINT = '#2EA894';
const AMBER = '#e0a540';
const INK = '#141c19';

/** A canvas sized to its box at the screen's pixel density, or null where canvas does not draw (jsdom, old browsers). */
function context(canvas: HTMLCanvasElement | null): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  if (!canvas) return null;
  let ctx: CanvasRenderingContext2D | null = null;
  try { ctx = canvas.getContext('2d'); } catch { return null; }
  if (!ctx) return null;
  const w = canvas.clientWidth, h = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
  if (!w || !h) return null;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/** Whether canvases draw here (not in jsdom or an old browser); clears this one. */
export const canvasDraws = (canvas: HTMLCanvasElement | null) => context(canvas) !== null;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** A pill's colours: its fill and its word's ink. Green for a healthy grade, amber for a raised one, red for a high one (US-75). */
export const PILL = { green: [GREEN, '#fff'], amber: [AMBER, INK], red: ['#b91c1c', '#fff'] } as const;

/** A grade pill on a canvas, the grade's word inside: Clarity records no canvas pixels (review P1). Drawn at
 *  the canvas's right edge, or its left with `left`. False where canvas does not draw. */
export function drawPill(canvas: HTMLCanvasElement | null, text: string, [fill, ink]: readonly [string, string], left = false): boolean {
  const c = context(canvas);
  if (!c) return false;
  const { ctx, w, h } = c;
  const font = getComputedStyle(canvas!).fontFamily || 'sans-serif';
  ctx.font = `700 14px ${font}`;
  const pw = Math.min(w, ctx.measureText(text).width + 24);
  const x = left ? 0 : w - pw;
  ctx.fillStyle = fill;
  roundRect(ctx, x, 0, pw, h, h / 2);
  ctx.fill();
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + pw / 2, h / 2 + 1);
  return true;
}

/** The 0.35 to 0.65 scale: healthy band to 0.5, raised band past it, the 0.5 line, and the ratio's marker. */
function drawScale(canvas: HTMLCanvasElement | null, ratio: number): boolean {
  const c = context(canvas);
  if (!c) return false;
  const { ctx, w, h } = c;
  const pad = 9, bar = 8, y = h / 2 - bar / 2;
  const x = (v: number) => pad + ((v - SCALE.min) / (SCALE.max - SCALE.min)) * (w - 2 * pad);
  ctx.fillStyle = MINT;
  roundRect(ctx, pad, y, x(SCALE.line) - pad, bar, bar / 2);
  ctx.fill();
  ctx.fillStyle = AMBER;
  roundRect(ctx, x(SCALE.line), y, w - pad - x(SCALE.line), bar, bar / 2);
  ctx.fill();
  ctx.fillStyle = INK;
  ctx.fillRect(x(SCALE.line) - 1, y - 4, 2, bar + 8);
  const mx = x(Math.min(SCALE.max, Math.max(SCALE.min, ratio)));
  ctx.beginPath();
  ctx.arc(mx, h / 2, 7, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = INK;
  ctx.stroke();
  return true;
}

/** The results, in a live region that is on the page before they arrive, so a
 *  screen reader reads them out (one inserted with its content often is not).
 *  An <output>, not a div: the storefront hides an empty div. */
export function ResultsView({ results }: { results: Results | null }) {
  const pill = useRef<HTMLCanvasElement>(null);
  const scale = useRef<HTMLCanvasElement>(null);
  // Whether the pill drew: where it did, the grade's word is read out but not shown twice.
  // It depends on the browser, never on the result.
  const [drawn, setDrawn] = useState(false);
  const whtr = results?.whtr;
  // Drawn before the browser paints: the grade's text line goes as the pill takes its place, never a
  // frame later, which moved everything under it by a line on load (Chrome layout shift, 2026-11-18).
  useLayoutEffect(() => {
    if (!whtr) return;
    const ok = !!whtr.status && drawPill(pill.current, whtr.status.label, whtr.status.tone === 'normal' ? PILL.green : PILL.amber) && drawScale(scale.current, Number(whtr.value));
    setDrawn(ok);
  }, [whtr]);

  return (
    <output className="hr-widget-results" aria-live="polite">
      {results && (
        <div className="hr-widget-res">
          {whtr && (
            <div className="hr-widget-ratio">
              <div className="hr-widget-ratio-top">
                <div>
                  <div className="hr-widget-k">Waist-to-height ratio</div>
                  <div className="hr-widget-v">{fixed(statTileText(whtr), WIDTH.ratio)}</div>
                </div>
                <canvas ref={pill} className="hr-widget-pill" aria-hidden="true" />
              </div>
              <span className={drawn ? 'hr-widget-sr' : 'hr-widget-status'}>{fixed(whtr.status?.label, WIDTH.grade)}</span>
              <canvas ref={scale} className="hr-widget-scale" aria-hidden="true" />
            </div>
          )}
          <div className="hr-widget-grid">
            {results.bmi && (
              <div>
                <div className="hr-widget-k">Body mass index (BMI)</div>
                {/* One line, "27.2 – Normal" (Brad 2026-11-18). The category is always there, a blank one too (no grade
                    for a known minor, or BMI 25-29.9 with no waist), and the dash is one padded character either way,
                    " – " or " ⁠ ": as Clarity encodes them (" 1 "), presence or length never tells the grade. */}
                <div className="hr-widget-s">
                  {fixed(statTileText(results.bmi), WIDTH.bmi)}
                  <span className="hr-widget-bmi-cat">
                    <span aria-hidden="true">{results.bmi.status?.label ? ' – ' : ` ${PAD} `}</span>
                    <span className="hr-widget-status">{fixed(results.bmi.status?.label, WIDTH.category)}</span>
                  </span>
                </div>
              </div>
            )}
            <div>
              <div className="hr-widget-k">Target waist circumference</div>
              <div className="hr-widget-s">{fixed(results.target, WIDTH.target)}</div>
            </div>
          </div>
        </div>
      )}
    </output>
  );
}
