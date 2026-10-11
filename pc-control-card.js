/**
 * PC Control Card · custom Lovelace card for Home Assistant
 *
 * A drop-in custom card with three variants:
 *   - `tile`    — compact toggle tile with 3 action buttons
 *   - `chip`    — Mushroom-style: icon chip + inline uptime + mini metrics
 *                 (CPU/GPU usage + temps, RAM, one row per disk, custom rows)
 *   - `feature` — full card with metric bars (CPU/GPU usage + temps, RAM,
 *                 one bar per disk, custom rows) + uptime + 3 actions
 */

const CARD_VERSION = "1.9.2";

// ── State machine ───────────────────────────────────────────────────
//   off / on are derived from the binary_sensor.
//   booting / shutting / sleeping are local "pending" overlays that
//   resolve when the sensor flips, or expire after a timeout.

const PENDING_TIMEOUT_MS = 300_000;
const RESTART_CONFIRM_DELAY_MS = 3_000;
const SLEEP_DISPLAY_MS = 6_000;
const ACTION_ERROR_DISPLAY_MS = 8_000;
const ARM_TIMEOUT_MS = 2_400;

// Graphs: number of points drawn, default period, refresh bounds.
const GRAPH_POINTS = 48;
const GRAPH_DEFAULT_HOURS = 24;
const GRAPH_MIN_REFRESH_MS = 60_000;
const GRAPH_MAX_REFRESH_MS = 900_000;
const GRAPH_RETRY_MS = 30_000;

const META = {
  off: { label: "Off", tone: "idle", pulse: false },
  on: { label: "On", tone: "live", pulse: false },
  sleeping: { label: "Sleeping", tone: "warm", pulse: false },
  booting: { label: "Booting", tone: "warm", pulse: true },
  shutting: { label: "Shutting down", tone: "alert", pulse: true },
  restarting: { label: "Restarting", tone: "warm", pulse: true },
  waking: { label: "Waking", tone: "warm", pulse: true },
  boot_timeout: { label: "Boot timeout", tone: "alert", pulse: false },
  shutdown_timeout: { label: "Shutdown timeout", tone: "alert", pulse: false },
  restart_timeout: { label: "Restart timeout", tone: "alert", pulse: false },
};

// ── Metric registry ─────────────────────────────────────────────────
// Single source of truth for the non-storage metric rows. Order here
// is the order they render in the chip mini-stats and the feature
// metric bars: usage and temperature pairs grouped per component.
const METRIC_KEYS = ["cpu_usage", "cpu_temp", "gpu_usage", "gpu_temp", "ram_usage"];
const METRIC_LABELS = {
  cpu_usage: "CPU",
  cpu_temp: "CPU TEMP",
  gpu_usage: "GPU",
  gpu_temp: "GPU TEMP",
  ram_usage: "RAM",
};

// ── Config migration ────────────────────────────────────────────────
// Pre-1.1 used cpu/ram/gpu (and ram_total) for both visibility flags
// and metric entity ids. 1.1+ namespaces these by purpose so a single
// component can carry both a usage% sensor and a °C sensor. This
// helper runs on every setConfig AND on the editor's flatten() path
// so old configs surface correctly in the visual editor too.
function migrateConfig(raw) {
  const out = { ...raw };
  if (out.metrics) {
    const m = { ...out.metrics };
    if (m.cpu && !m.cpu_usage) m.cpu_usage = m.cpu;
    if (m.ram && !m.ram_usage) m.ram_usage = m.ram;
    if (m.gpu && !m.gpu_usage) m.gpu_usage = m.gpu;
    if (m.ram_total && !m.ram_usage_total) m.ram_usage_total = m.ram_total;
    delete m.cpu;
    delete m.ram;
    delete m.gpu;
    delete m.ram_total;
    out.metrics = m;
  }
  return out;
}

// ── Helpers ─────────────────────────────────────────────────────────

// Parse an action config into a normalized shape with the service
// already split into domain + action. Accepts a bare entity_id
// ("switch.x" / "button.x" / "script.x") and infers the service, or a
// full { entity, service: 'domain.action' } object.
// Returns { entity, domain, service } where `service` is the action
// name ("turn_on", "press", …) ready for callService(domain, service).
export function parseAction(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    const [domain] = raw.split(".");
    const service =
      domain === "switch"
        ? "turn_on"
        : domain === "button"
          ? "press"
          : domain === "script"
            ? "turn_on"
            : domain === "input_button"
              ? "press"
              : domain === "automation"
                ? "trigger"
                : null;
    if (!service) return null;
    return { entity: raw, domain, service };
  }
  if (raw.entity && raw.service) {
    const [domain, service] = raw.service.split(".");
    if (!domain || !service) return null;
    return { entity: raw.entity, domain, service };
  }
  return null;
}

function fmtUptime(ms) {
  if (ms < 0 || !Number.isFinite(ms)) return "—";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Compute uptime in milliseconds from an uptime/last-boot entity, or null.
// Handles a timestamp sensor (device_class 'timestamp' or any ISO-parseable
// state) and a numeric duration sensor (unit-aware: d/h/min, default seconds).
// `Number(raw)` — not parseFloat — is used so date strings like "2024-01-01"
// (which parseFloat would read as 2024) fall through to date parsing.
export function uptimeMsFromEntity(ent, now = Date.now()) {
  if (!ent || ent.state == null) return null;
  const raw = String(ent.state);
  const num = Number(raw);
  if (ent.attributes?.device_class === "timestamp" || !Number.isFinite(num)) {
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? now - t : null;
  }
  const unit = (ent.attributes?.unit_of_measurement || "").toLowerCase();
  const mult = /^(d|day|days)$/.test(unit)
    ? 86_400_000
    : /^(h|hr|hrs|hour|hours)$/.test(unit)
      ? 3_600_000
      : /^(min|m|minute|minutes)$/.test(unit)
        ? 60_000
        : 1000;
  return num * mult;
}

// Format a number for the value label. Single decimal under 10, no
// decimals at 10+, three significant figures otherwise.
function fmtNum(n) {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

// Default set of drive status states treated as healthy. Synology
// reports "normal" for healthy disks. Overridable per card via
// the `healthy_states` config key.
export const DEFAULT_HEALTHY = ["normal", "ok", "healthy", "good"];

// True when a status state string is considered healthy. `healthyStates`
// must already be lowercased by the caller.
export function driveHealthy(state, healthyStates) {
  if (state == null) return false;
  return healthyStates.includes(String(state).trim().toLowerCase());
}

// Scale a data-size value (and its total, kept in the same unit) up the
// binary ladder so it reads naturally — e.g. 953674 MB → 931 GB. The target
// unit is driven by the larger of value/total so both share it. An unknown
// source unit passes through untouched.
const DATA_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];
function scaleDataSize(value, total, unit) {
  const base = DATA_UNITS.indexOf(unit);
  if (base < 0) return { value, total, unit };
  const ref = Number.isFinite(total) && total > 0 ? total : value;
  let steps = 0;
  for (let r = ref; r >= 1024 && base + steps < DATA_UNITS.length - 1; r /= 1024) steps++;
  const f = 1024 ** steps;
  return {
    value: value / f,
    total: Number.isFinite(total) ? total / f : total,
    unit: DATA_UNITS[base + steps],
  };
}

// Pure value resolver + formatter. Given an entity's state object (and an
// optional separate "total" entity), return both a display string and a
// 0–100 bar percentage — or null when there's no usable number.
//
// The value is resolved in priority order:
//   1. opts.attribute   → read from ent.attributes[attribute]
//   2. ent.state        → when numeric
//   3. opts.autoDetect  → HASS.Agent's UsedSpacePercentage attribute
//                         (its state is the volume label, not a number)
//
// Display mode follows opts.totalConfigured (a total source was set) or
// opts.unit (an explicit source unit, which forces absolute display):
//   - finite total > 0 → absolute ("6.8 / 16 GB")
//   - total unavailable → single value, no bar
//   - neither          → percent ("42%")
// The total itself comes from opts.totalAttribute (same entity) or, failing
// that, the separate totalEnt's state. opts.unit (e.g. "MB") overrides the
// entity's unit and auto-scales value+total up the data-size ladder.
//
// Exported so the parsing/formatting logic can be unit-tested without a DOM.
export function computeMetricDisplay(ent, totalEnt, opts = {}) {
  if (!ent) return null;
  const {
    attribute = null,
    totalAttribute = null,
    totalConfigured = false,
    autoDetect = false,
    unit: unitOverride = null,
  } = opts;

  let value;
  let unit = unitOverride || (ent.attributes?.unit_of_measurement ?? "");
  if (attribute) {
    value = parseFloat(ent.attributes?.[attribute]);
  } else {
    value = parseFloat(ent.state);
    if (!Number.isFinite(value) && autoDetect) {
      const auto = parseFloat(ent.attributes?.UsedSpacePercentage);
      if (Number.isFinite(auto)) {
        value = auto;
        unit = "";
      } // percentage — no unit suffix
    }
  }
  if (!Number.isFinite(value)) return null;

  let total = null;
  if (totalAttribute) total = parseFloat(ent.attributes?.[totalAttribute]);
  else if (totalEnt) total = parseFloat(totalEnt.state);

  // An explicit source unit auto-scales value + total to a readable magnitude.
  if (unitOverride) ({ value, total, unit } = scaleDataSize(value, total, unit));

  const space = unit ? " " : "";
  if (totalConfigured || unitOverride) {
    if (Number.isFinite(total) && total > 0) {
      return {
        displayValue: `${fmtNum(value)} / ${fmtNum(total)}${space}${unit}`,
        compactValue: `${fmtNum(value)}${space}${unit}`,
        barPct: Math.max(0, Math.min(100, (value / total) * 100)),
      };
    }
    return {
      displayValue: `${fmtNum(value)}${space}${unit}`,
      compactValue: `${fmtNum(value)}${space}${unit}`,
      barPct: null,
    };
  }

  const pct = `${Math.round(value)}${unit || "%"}`;
  return { displayValue: pct, compactValue: pct, barPct: Math.max(0, Math.min(100, value)) };
}

// ── Custom metrics ──────────────────────────────────────────────────

// Strict numeric check — `Number("1.2.3")` is NaN but `Number("0x10")` is 16
// and `parseFloat("1.2.3")` is 1.2, so a regex gates what counts as a number.
const NUMERIC_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

// Integers stay integers ("11", not "11.0"); anything else gets at most
// two decimals with trailing zeros dropped ("12.50" → "12.5").
export function fmtCustomNumber(n) {
  if (Number.isInteger(n)) return String(n);
  return String(parseFloat(n.toFixed(2)));
}

// "in 27 days" / "3 hours ago" for timestamp sensors (e.g. "Certificate
// expires"). Uses the browser's Intl so it follows the HA language.
export function fmtRelativeTime(diffMs, locale) {
  const abs = Math.abs(diffMs);
  const steps = [
    ["second", 1000, 60_000],
    ["minute", 60_000, 3_600_000],
    ["hour", 3_600_000, 86_400_000],
    ["day", 86_400_000, 2_592_000_000],
    ["month", 2_592_000_000, 31_536_000_000],
  ];
  let unit = "year";
  let div = 31_536_000_000;
  for (const [u, d, limit] of steps) {
    if (abs < limit) {
      unit = u;
      div = d;
      break;
    }
  }
  const v = Math.round(diffMs / div);
  for (const loc of [locale || undefined, undefined]) {
    try {
      return new Intl.RelativeTimeFormat(loc, { numeric: "auto" }).format(v, unit);
    } catch {
      /* invalid locale → retry with the default one */
    }
  }
  return `${v} ${unit}`;
}

// Strict number from a state/attribute value, or null.
function toStrictNumber(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && NUMERIC_RE.test(raw.trim())) return Number(raw.trim());
  return null;
}

// The maximum of a custom row: the positive number read from `maxEnt` (its
// state or `maxAttribute`) when `maxEntity` is set — with NO fallback to
// `max` if it can't be read — else the fixed `max`; null when neither.
export function resolveCustomMax({ max = null, maxEntity = null, maxEnt = null, maxAttribute = null } = {}) {
  if (maxEntity) {
    const n = toStrictNumber(maxAttribute ? maxEnt?.attributes?.[maxAttribute] : maxEnt?.state);
    return n != null && n > 0 ? n : null;
  }
  return Number.isFinite(max) && max > 0 ? max : null;
}

// Pure resolver for one custom metric row. Returns null when there's no
// usable value (entity missing, unavailable/unknown, empty attribute).
//
//   - value comes from opts.attribute, else the entity state
//   - numeric values keep integers as integers and get the unit
//     (opts.unit, else the entity's unit_of_measurement — state only)
//   - text values are shown as-is; the unit is not applied to text
//   - timestamp sensors (device_class "timestamp") show a relative time
//   - opts.template replaces "{value}" with the formatted value and
//     "{max}" with the bar maximum (same unit; "—" when there is none)
//   - opts.bar + numeric value → barPct against the maximum, which is
//       · opts.maxEntity set → the number read from opts.maxEnt (its state,
//         or opts.maxAttribute). If that isn't a positive number there is
//         NO fallback: the bar stays empty rather than lie.
//       · otherwise opts.max, defaulting to 100.
//
// displayValue is the template-applied text, compactValue the bare value
// (used by the narrow chip variant).
export function computeCustomDisplay(ent, opts = {}) {
  if (!ent) return null;
  const {
    attribute = null,
    unit: unitOverride = null,
    template = null,
    bar = false,
    max = null,
    maxEntity = null,
    maxEnt = null,
    maxAttribute = null,
    locale = null,
    now = Date.now(),
  } = opts;

  let raw;
  if (attribute) {
    raw = ent.attributes?.[attribute];
  } else {
    raw = ent.state;
    if (raw === "unavailable" || raw === "unknown") return null;
  }
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw)) raw = raw.join(", ");
  else if (typeof raw === "object") raw = JSON.stringify(raw);

  const str = String(raw).trim();
  if (str === "") return null;

  // Bar maximum: from an entity (+ optional attribute) or a fixed number.
  const maxN = resolveCustomMax({ max, maxEntity, maxEnt, maxAttribute });

  const isNum = typeof raw === "number" ? Number.isFinite(raw) : NUMERIC_RE.test(str);
  let text;
  let unitSuffix = "";
  let barPct = null;
  if (isNum) {
    const n = typeof raw === "number" ? raw : Number(str);
    const unit = unitOverride ?? (attribute ? "" : (ent.attributes?.unit_of_measurement ?? ""));
    unitSuffix = unit ? (unit === "%" ? "" : " ") + unit : "";
    text = fmtCustomNumber(n) + unitSuffix;
    if (bar) {
      const barMax = maxEntity ? maxN : (maxN ?? 100);
      if (barMax != null) barPct = Math.max(0, Math.min(100, (n / barMax) * 100));
    }
  } else if (!attribute && ent.attributes?.device_class === "timestamp" && Number.isFinite(Date.parse(str))) {
    text = fmtRelativeTime(Date.parse(str) - now, locale);
  } else {
    text = str;
  }

  let displayValue = text;
  if (template) {
    const maxText = maxN != null ? fmtCustomNumber(maxN) + unitSuffix : "—";
    // Single pass so a value that happens to contain "{max}" isn't re-expanded.
    displayValue = String(template).replace(/\{(value|max)\}/g, (_m, k) => (k === "value" ? text : maxText));
  }
  return { displayValue, compactValue: text, barPct };
}

// ── Graph helpers ───────────────────────────────────────────────────
// Pure functions (no DOM, no hass) so they can be unit-tested under Node.

// Top of a built-in metric's graph, mirroring computeMetricDisplay's modes:
//   - total configured (separate entity / attribute) or explicit unit → that
//     total, in the SOURCE unit (graph values aren't rescaled either)
//   - plain percent mode → 100 when the unit is % (or none), else null
//     (e.g. a °C sensor auto-scales — a 0–100 axis would flatten it)
// null = auto-scale.
export function computeMetricMax(ent, totalEnt, opts = {}) {
  const { totalAttribute = null, totalConfigured = false, unit: unitOverride = null } = opts;
  if (!ent) return null;
  if (totalConfigured || unitOverride) {
    const t = totalAttribute
      ? parseFloat(ent.attributes?.[totalAttribute])
      : totalEnt
        ? parseFloat(totalEnt.state)
        : NaN;
    return Number.isFinite(t) && t > 0 ? t : null;
  }
  const u = ent.attributes?.unit_of_measurement ?? "";
  return u === "%" || u === "" ? 100 : null;
}

// Numeric value of one history sample / current state, or null. Same source
// rules as the row itself: an explicit attribute, else the state, else (for
// HASS.Agent-style storage sensors) the UsedSpacePercentage attribute.
// `strict` (custom rows) refuses "1.2.3"-style strings; built-in rows keep
// parseFloat's leniency, like the bars.
export function graphValue(state, attrs, opts = {}) {
  const { attribute = null, autoDetect = false, strict = false } = opts;
  const num = (x) => {
    if (strict) return toStrictNumber(x);
    const n = parseFloat(x);
    return Number.isFinite(n) ? n : null;
  };
  if (attribute) return num(attrs?.[attribute]);
  const v = num(state);
  if (v != null) return v;
  if (autoDetect) return num(attrs?.UsedSpacePercentage);
  return null;
}

function toMs(x) {
  if (typeof x === "number") return Number.isFinite(x) ? (x < 1e12 ? x * 1000 : x) : null;
  if (typeof x === "string") {
    const t = Date.parse(x);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// Decode the websocket history list for one entity into [[ms, value], …].
// Handles the compressed format (s = state, a = attributes, lu/lc = epoch
// seconds, lc only when it differs from lu) and the long REST-style keys.
// Attributes are carried forward when a sample omits them. Samples without
// a usable time or number (unavailable, text…) are dropped.
export function parseHistoryPoints(list, opts = {}) {
  const out = [];
  let attrs = null;
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || typeof p !== "object") continue;
    if (p.a) attrs = p.a;
    else if (p.attributes) attrs = p.attributes;
    const t = toMs(p.lu ?? p.lc ?? p.last_updated ?? p.last_changed);
    const v = graphValue(p.s ?? p.state, attrs, opts);
    if (t != null && v != null) out.push([t, v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

// Time-weighted resampling of a step series (a value holds until the next
// change) into `n` equal buckets over [start, end]. Buckets before the first
// known sample are skipped. A dense sensor therefore keeps its average shape
// instead of aliasing on whichever sample lands on the bucket edge.
export function resampleSeries(points, start, end, n = GRAPH_POINTS) {
  const out = [];
  if (!points.length || !(end > start) || n < 1) return out;
  const step = (end - start) / n;
  let i = 0;
  for (let b = 0; b < n; b++) {
    const b0 = start + b * step;
    const b1 = b0 + step;
    while (i + 1 < points.length && points[i + 1][0] <= b0) i++;
    const known = points[i][0] <= b0;
    let cur = known ? points[i][1] : null;
    let k = known ? i + 1 : i;
    let t = b0;
    let acc = 0;
    let covered = 0;
    for (;;) {
      const nextT = k < points.length && points[k][0] < b1 ? points[k][0] : b1;
      if (cur != null) {
        acc += cur * (nextT - t);
        covered += nextT - t;
      }
      if (nextT >= b1) break;
      t = nextT;
      cur = points[k][1];
      k++;
    }
    if (covered > 0) out.push([b0 + step / 2, acc / covered]);
  }
  return out;
}

// Vertical range of a graph. With a known maximum the axis is 0..max (grown
// if the data exceeds it); otherwise it fits the data with 10% breathing room.
export function graphRange(values, max = null) {
  if (!values.length) return { lo: 0, hi: 1 };
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (max != null) return { lo: Math.min(0, lo), hi: Math.max(max, hi) };
  if (lo === hi) {
    const pad = Math.abs(lo) * 0.1 || 1;
    return { lo: lo - pad, hi: hi + pad };
  }
  const pad = (hi - lo) * 0.1;
  return { lo: lo - pad, hi: hi + pad };
}

// SVG path data for a [[ms, value], …] series in a W×H viewBox: a line and a
// closed area under it. Needs ≥ 2 points, otherwise null.
export function graphPaths(series, start, end, range, W = 100, H = 32) {
  if (!series || series.length < 2) return null;
  const span = end - start || 1;
  const h = range.hi - range.lo || 1;
  const inset = 2; // keeps the stroke from being clipped at the top/bottom
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const f = (n) => Math.round(n * 100) / 100;
  const pts = series.map(([t, v]) => [
    clamp((t - start) / span, 0, 1) * W,
    clamp(H - inset - ((v - range.lo) / h) * (H - 2 * inset), inset, H - inset),
  ]);
  // Anchor the first sample to the left edge, like the progress bar.
  pts[0][0] = 0;
  const line = "M" + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join(" L");
  const area = `${line} L${f(pts[pts.length - 1][0])} ${H} L${f(pts[0][0])} ${H} Z`;
  return { line, area };
}

// ── Styles ──────────────────────────────────────────────────────────
// Named STYLES (not CSS) to avoid shadowing the global `CSS` object.

const STYLES = `
:host {
  --spc-accent: var(--primary-color, oklch(0.58 0.13 250));
  --spc-warn:   var(--warning-color, #f5a623);
  --spc-alert:  var(--error-color, #db4437);
  --spc-ok:     var(--success-color, #2f9e6e);
  --spc-bg:     var(--ha-card-background, var(--card-background-color, #fff));
  --spc-fg:     var(--primary-text-color, #1a1a1a);
  --spc-fg-2:   var(--secondary-text-color, #6b7280);
  --spc-border: var(--divider-color, rgba(0,0,0,0.08));
  --spc-radius: var(--ha-card-border-radius, 18px);
  display: block;
  font-family: var(--paper-font-body1_-_font-family, -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif);
  color: var(--spc-fg);
  -webkit-font-smoothing: antialiased;
}
.card {
  /* ha-card is undefined outside HA, so it defaults to display: inline,
     which prevents the background/border from painting around block
     children. Force it to block in our context. */
  display: block;
  background: var(--spc-bg);
  border-radius: var(--spc-radius);
  border: 1px solid var(--spc-border);
  box-shadow: var(--ha-card-box-shadow, 0 1px 2px rgba(0,0,0,0.03), 0 4px 16px -8px rgba(0,0,0,0.06));
  overflow: hidden;
  box-sizing: border-box;
  position: relative;
}
.card.action-error {
  border-color: var(--spc-alert);
}
.card.action-error::after {
  content: "";
  position: absolute;
  inset: 0;
  border: 2px solid var(--spc-alert);
  border-radius: inherit;
  box-sizing: border-box;
  pointer-events: none;
  animation: spcCardError 1.6s ease-out infinite;
}

/* ── Atoms ─────────────────────────────────────────────────────── */
.dot {
  width: 8px; height: 8px; border-radius: 999px;
  background: var(--spc-fg-2);
  display: inline-block; flex-shrink: 0;
  transition: background 220ms;
}
.dot.live   { background: var(--spc-accent); }
.dot.warm   { background: var(--spc-warn); }
.dot.alert  { background: var(--spc-alert); }
.dot.idle   { background: var(--spc-fg-2); opacity: 0.55; }
.dot.pulse  { animation: spcPulse 1.6s ease-out infinite; box-shadow: 0 0 0 0 currentColor; }
.dot.live.pulse  { color: var(--spc-accent); }
.dot.warm.pulse  { color: var(--spc-warn); }
.dot.alert.pulse { color: var(--spc-alert); }

@keyframes spcPulse {
  0%   { box-shadow: 0 0 0 0   currentColor; }
  70%  { box-shadow: 0 0 0 6px transparent;  }
  100% { box-shadow: 0 0 0 0   transparent;  }
}
@keyframes spcRing {
  0%   { transform: scale(1);   opacity: 0.55; }
  100% { transform: scale(1.3); opacity: 0; }
}
@keyframes spcSpin { to { transform: rotate(360deg); } }
@keyframes spcDots {
  0%, 20%   { width: 0; }
  100%      { width: 14px; }
}
@keyframes spcCardError {
  0%   { box-shadow: inset 0 0 0 2px var(--spc-alert); opacity: 0.85; }
  70%  { box-shadow: inset 0 0 0 8px transparent; opacity: 0.35; }
  100% { box-shadow: inset 0 0 0 2px transparent; opacity: 0; }
}

.dots::after {
  content: '…';
  display: inline-block; overflow: hidden;
  width: 0; vertical-align: bottom;
  animation: spcDots 1.2s steps(4) infinite;
}

.btn {
  flex: 1;
  height: 44px;
  border-radius: 12px;
  border: 1px solid var(--spc-border);
  background: var(--spc-bg);
  color: var(--spc-fg);
  font: inherit; font-size: 13px; font-weight: 500;
  letter-spacing: -0.005em;
  white-space: nowrap;
  display: inline-flex; align-items: center; justify-content: center;
  gap: 8px;
  cursor: pointer; user-select: none;
  -webkit-tap-highlight-color: transparent;
  transition: transform 90ms cubic-bezier(.2,.7,.2,1), background 160ms, border-color 160ms, color 160ms;
}
.btn:hover:not(:disabled) { background: color-mix(in oklab, var(--spc-fg) 6%, var(--spc-bg)); }
.btn:active:not(:disabled) { transform: scale(0.965); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn.primary {
  background: var(--spc-accent);
  border-color: var(--spc-accent);
  color: var(--ha-card-button-text-color, #fff);
}
.btn.primary:hover:not(:disabled) {
  background: color-mix(in oklab, #000 8%, var(--spc-accent));
}
.btn.danger { color: var(--spc-alert); }
.btn.armed {
  background: color-mix(in oklab, var(--spc-alert) 12%, var(--spc-bg));
  border-color: color-mix(in oklab, var(--spc-alert) 40%, var(--spc-border));
  color: var(--spc-alert);
}
.btn.compact { height: 40px; padding: 0 8px; font-size: 12.5px; gap: 6px; }

/* Label stack — both labels share one grid cell so the button is as
   wide as the LONGER label and never shifts when armed. When the
   confirm label is omitted (no confirmation required), only .normal
   is rendered and the stack still works as a 1-cell layout. */
.btn .lbl-stack { display: inline-grid; align-items: center; justify-items: center; }
.btn .lbl-stack > .lbl {
  grid-area: 1 / 1;
  display: inline-flex; align-items: center; gap: 6px;
  white-space: nowrap;
  visibility: hidden;
}
.btn:not(.armed) .lbl-stack > .lbl.normal  { visibility: visible; }
.btn.armed       .lbl-stack > .lbl.confirm { visibility: visible; }

.spinner {
  width: 14px; height: 14px;
  display: inline-block;
  animation: spcSpin 0.9s linear infinite;
}

.icon-box {
  display: inline-flex; align-items: center; justify-content: center;
  line-height: 0;
  flex-shrink: 0;
  transition: background 220ms, color 220ms;
  position: relative;
}
.icon-box > svg,
.icon-box > ha-icon { display: block; }
.header-icon {
  --mdc-icon-size: 22px;
  width: 22px;
  height: 22px;
}
.icon-box .ring {
  position: absolute; inset: -2px; border-radius: inherit;
  border: 2px solid var(--spc-accent);
  animation: spcRing 1.6s ease-out infinite;
  pointer-events: none;
}
.icon-box .ring.warm  { border-color: var(--spc-warn); }
.icon-box .ring.alert { border-color: var(--spc-alert); }

/* ── Tile variant ─────────────────────────────────────────────── */
.tile .head {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 14px 12px;
}
.tile .circle {
  width: 44px; height: 44px; border-radius: 12px;
  background: color-mix(in oklab, var(--spc-fg) 8%, var(--spc-bg));
  color: var(--spc-fg-2);
  border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 220ms, color 220ms, transform 90ms cubic-bezier(.2,.7,.2,1);
}
.tile .circle:active:not(:disabled) { transform: scale(0.94); }
.tile .circle:disabled { cursor: not-allowed; }
.tile.is-on  .circle, .tile.is-sleeping .circle { background: var(--spc-accent); color: #fff; }
.tile .name { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
.tile .status { font-size: 12px; color: var(--spc-fg-2); display: flex; align-items: center; gap: 6px; margin-top: 2px; }
.tile .actions { display: flex; gap: 6px; padding: 0 14px 14px; }
.tile.no-actions .head { padding: 14px; }
.tile.no-actions .actions { display: none; }
.chip.no-actions .actions,
.chip.no-actions .divider { display: none; }
.feature.no-actions .actions { display: none; }

/* ── Chip variant (Mushroom-style) ────────────────────────────── */
.chip .head {
  display: flex; gap: 14px; padding: 18px; align-items: flex-start;
}
.chip .icon-box.chip-icon {
  width: 44px; height: 44px; border-radius: 12px;
  background: color-mix(in oklab, var(--spc-fg) 8%, var(--spc-bg));
  color: var(--spc-fg-2);
}
.chip.is-on        .icon-box.chip-icon { background: var(--spc-accent); color: #fff; }
.chip.is-sleeping  .icon-box.chip-icon { background: var(--spc-warn);   color: #fff; }
.chip .head .meta { flex: 1; min-width: 0; }
.chip .name { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
.chip .status {
  display: flex; align-items: center; gap: 6px; margin-top: 2px;
  font-size: 12.5px; color: var(--spc-fg-2);
}
.chip .status .uptime-sep { color: var(--spc-fg-2); opacity: 0.5; }
.chip .status .uptime-inline {
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
}
/* Mini-stats grid. Caps at 2 columns so >3 metrics wrap to a second
   row instead of squeezing into a single line. With max-content
   columns, an empty 2nd column collapses to 0 — so 1 visible item
   renders as a single column with no leading whitespace. */
.chip .mini-stats {
  display: grid;
  grid-template-columns: repeat(2, max-content);
  column-gap: 14px;
  row-gap: 6px;
  justify-content: end;
  flex-shrink: 0;
}
.chip .mini-stat { text-align: right; min-width: 0; }
.chip .mini-stat.info-row,
.feature .metric.info-row,
.feature .drive.info-row,
.feature .uptime.info-row {
  cursor: pointer;
}
.info-row:focus,
.info-row:focus-visible,
.info-row:focus-within {
  outline: none !important;
  box-shadow: none !important;
}
.card:has(.info-row:focus) {
  outline: none !important;
  box-shadow: none !important;
}
.chip .mini-stat.info-row:hover,
.feature .metric.info-row:hover,
.feature .drive.info-row:hover,
.feature .uptime.info-row:hover {
  opacity: 0.78;
}
.chip .mini-stat .mlabel {
  font-size: 10px; color: var(--spc-fg-2);
  letter-spacing: 0.06em; text-transform: uppercase;
}
.chip .mini-stat .mval {
  font-size: 14px; font-weight: 600;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-variant-numeric: tabular-nums;
  margin-top: 1px;
}
/* Custom rows can hold free text (a status, a version…) — keep them from
   stretching the grid; the full text stays available as a tooltip. */
.chip .mini-stat.custom .mlabel,
.chip .mini-stat.custom .mval {
  max-width: 120px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chip .divider { height: 1px; background: var(--spc-border); margin: 0 18px; }
.chip .actions { display: flex; gap: 8px; padding: 18px; }

/* ── Feature variant ──────────────────────────────────────────── */
.feature { display: flex; flex-direction: column; }
.feature .head {
  display: flex; align-items: flex-start; gap: 14px;
  padding: 20px 22px 18px;
}
.feature .icon-box.lg {
  width: 44px; height: 44px; border-radius: 12px;
  background: color-mix(in oklab, var(--spc-fg) 8%, var(--spc-bg));
  color: var(--spc-fg-2);
}
.feature.is-on .icon-box.lg { background: var(--spc-accent); color: #fff; }
.feature .head .meta { flex: 1; min-width: 0; }
.feature .name { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
.feature .status { display: flex; align-items: center; gap: 8px; margin-top: 2px; font-size: 13px; font-weight: 500; }
.feature .status .label { color: var(--spc-fg-2); }
.tile .status.live .label,
.chip .status.live .label,
.feature .status.live .label { color: var(--spc-accent); }
.tile .status.warm .label,
.chip .status.warm .label,
.feature .status.warm .label { color: var(--spc-warn); }
.tile .status.alert .label,
.chip .status.alert .label,
.feature .status.alert .label { color: var(--spc-alert); }
.feature .uptime { text-align: right; min-width: 0; }
.feature .uptime .ulabel {
  font-size: 10px; color: var(--spc-fg-2);
  letter-spacing: 0.08em; text-transform: uppercase;
}
.feature .uptime .uval {
  font-size: 15px; font-weight: 500;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-variant-numeric: tabular-nums;
  margin-top: 2px;
}
.feature .uptime .uval.dim { color: var(--spc-fg-2); }
.feature:not(.is-on) .metrics { opacity: 0.35; }
.metric-head {
  display: flex; justify-content: space-between; margin-bottom: 5px;
}
.metric-head .mlabel {
  font-size: 11px; color: var(--spc-fg-2);
  letter-spacing: 0.04em; text-transform: uppercase; font-weight: 500;
}
.metric-head .mval {
  font-size: 12px; color: var(--spc-fg);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-variant-numeric: tabular-nums;
}
.metric-bar {
  height: 5px; border-radius: 4px;
  background: color-mix(in oklab, var(--spc-fg) 6%, var(--spc-bg));
  overflow: hidden;
}
.metric-bar .fill {
  height: 100%; border-radius: 4px;
  background: var(--spc-accent);
  width: 0;
  transition: width 600ms cubic-bezier(.4,0,.2,1);
}
/* Custom rows: label + free-form value, with an optional bar. A row
   without a bar has no use for the head's bottom margin. */
.metric.custom .metric-head { gap: 12px; }
.metric.custom .metric-head .mlabel { flex-shrink: 0; }
.metric.custom .metric-head .mval {
  min-width: 0; text-align: right;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.metric.no-bar .metric-head { margin-bottom: 0; }
/* Graph (sparkline) in place of the bar. The viewBox is stretched to the row
   width, so the stroke is non-scaling to stay crisp and even. */
.metric-graph {
  position: relative;
  height: 32px; border-radius: 6px; overflow: hidden;
}
.metric-graph svg { display: block; width: 100%; height: 100%; }
.metric-graph .garea { fill: var(--spc-accent); fill-opacity: 0.16; stroke: none; }
.metric-graph .gline {
  fill: none; stroke: var(--spc-accent); stroke-width: 1.5;
  stroke-linejoin: round; stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}
.metric.has-graph .metric-head { margin-bottom: 5px; }
/* Shown instead of a curve while there is nothing to draw (loading, no
   history, history unavailable), so a graph row never looks broken. */
.metric-graph .gempty {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; color: var(--spc-fg-2);
}
.metric-graph .gempty[hidden] { display: none; }
.feature .actions {
  margin-top: auto;
  padding: 22px;
  border-top: 1px solid var(--spc-border);
  display: flex; gap: 8px;
}
.feature .metrics {
  padding: 6px 22px 16px;
  display: flex; flex-direction: column; gap: 12px;
  transition: opacity 220ms, padding 220ms;
}
.feature.no-actions .metrics { padding-bottom: 22px; }

/* ── Drive health (NAS) ───────────────────────────────────────── */
.feature .drive { display: flex; align-items: center; gap: 8px; }
.feature .drive .ddot {
  width: 8px; height: 8px; border-radius: 999px;
  background: var(--spc-fg-2); flex-shrink: 0;
}
.feature .drive .ddot.ok  { background: var(--spc-ok); }
.feature .drive .ddot.bad { background: var(--spc-alert); }
.feature .drive .dname { font-size: 12px; color: var(--spc-fg); flex: 1; min-width: 0; }
.feature .drive .dval {
  font-size: 12px; color: var(--spc-fg-2);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-variant-numeric: tabular-nums;
}
.chip .mini-stat .mval.bad { color: var(--spc-alert); }
`;

// ── Icons (inline SVG strings) ──────────────────────────────────────

const ICONS = {
  power:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v8"/><path d="M5.6 7.6a8 8 0 1 0 12.8 0"/></svg>',
  moon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
  restart:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v5h-5"/></svg>',
  pc: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/></svg>',
  nas: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="7" rx="1.5"/><rect x="4" y="14" width="16" height="7" rx="1.5"/><path d="M8 6.5h.01"/><path d="M8 17.5h.01"/></svg>',
  spinner:
    '<svg class="spinner" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" stroke-opacity="0.18"/><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
};

function headerIcon(icon) {
  if (ICONS[icon]) return ICONS[icon];
  if (typeof icon === "string" && /^[a-z0-9_-]+:[a-z0-9_-]+$/.test(icon)) {
    return `<ha-icon class="header-icon" icon="${escapeHtml(icon)}"></ha-icon>`;
  }
  return ICONS.pc;
}

// ── The card ────────────────────────────────────────────────────────

// In a browser this resolves to the real HTMLElement. Under Node (where
// the module is imported for unit tests) there's no DOM, so fall back to a
// bare base class — the custom-element machinery is never exercised there.
const HTMLElementBase = typeof HTMLElement !== "undefined" ? HTMLElement : class {};

export class PcControlCard extends HTMLElementBase {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._pending = null; // 'on' | 'sleep' | 'restart' | 'shutdown'
    this._pendingSince = 0;
    this._pendingTimer = null;
    this._actionError = null;
    this._actionErrorTimer = null;
    this._armed = { sleep: false, shutdown: false, restart: false };
    this._restartDipped = false;
    this._armTimers = {};
    this._sleepTimer = null;
    this._tickTimer = null;
  }

  setConfig(config) {
    if (!config) throw new Error("pc-control-card: config required");
    if (!config.status_entity) {
      throw new Error(
        "pc-control-card: `status_entity` is required (e.g. binary_sensor.pc_status — binary_sensor, sensor, or switch all work)",
      );
    }
    const migrated = migrateConfig(config);
    this._config = {
      variant: "tile",
      name: "My PC",
      status_entity: "binary_sensor.pc_status",
      uptime_entity: null,
      turn_on: null,
      sleep: null,
      restart: null,
      shutdown: null,
      confirm_shutdown: true,
      confirm_sleep: false,
      confirm_restart: true,
      accent_color: null,
      healthy_states: null,
      icon: "pc",
      metrics: {},
      ...migrated,
    };
    if (Array.isArray(this._config.drives)) {
      this._config.drives = this._config.drives.map(({ status, temp, name }) => ({ status, temp, name }));
    }
    this._storages = this._normalizeStorages();
    this._drives = this._normalizeDrives();
    this._customs = this._normalizeCustomMetrics();
    this._initGraphs();
    this._healthyStates = (
      Array.isArray(this._config.healthy_states) && this._config.healthy_states.length
        ? this._config.healthy_states
        : DEFAULT_HEALTHY
    ).map((s) => String(s).toLowerCase());
    this._actions = {
      turn_on: parseAction(this._config.turn_on),
      sleep: parseAction(this._config.sleep),
      restart: parseAction(this._config.restart),
      shutdown: parseAction(this._config.shutdown),
    };
    this._build();
    this._update();
  }

  set hass(hass) {
    this._hass = hass;
    // Clear pending overlay when the sensor confirms the action.
    if (this._pending && hass) {
      const statusEntity = hass.states[this._config.status_entity];
      const s = statusEntity?.state;
      if (this._pending === "on" && s === "on") this._clearPending();
      if (this._pending === "shutdown" && s === "off") this._clearPending();
      if (this._pending === "restart") {
        // Reboot takes the box down (off/unavailable) then back to on.
        if (s !== "on") this._restartDipped = true;
        const changedAt = Date.parse(statusEntity?.last_changed || statusEntity?.last_updated || "");
        const statusChangedAfterAction = Number.isFinite(changedAt) && changedAt >= this._pendingSince;
        const restartStarted = Date.now() - this._pendingSince >= RESTART_CONFIRM_DELAY_MS;
        if ((this._restartDipped || statusChangedAfterAction || restartStarted) && s === "on") this._clearPending();
      }
      if (
        this._actionError &&
        ((this._actionError === "boot_timeout" && s === "on") ||
          (this._actionError === "shutdown_timeout" && s === "off") ||
          (this._actionError === "restart_timeout" && s === "on"))
      ) {
        this._clearActionError();
      }
    }
    this._update();
  }

  getCardSize() {
    const v = this._variant();
    if (v === "feature") return 4;
    if (v === "chip") return 2;
    return 1; // tile is roughly half the height of chip
  }

  static getConfigElement() {
    // Returns the visual editor element HA shows in the dashboard UI.
    // Lives in PcControlCardEditor below.
    return document.createElement("pc-control-card-editor");
  }

  static getStubConfig() {
    return {
      variant: "tile",
      name: "My PC",
      status_entity: "binary_sensor.pc_status",
    };
  }

  disconnectedCallback() {
    Object.values(this._armTimers).forEach(clearTimeout);
    clearTimeout(this._sleepTimer);
    clearTimeout(this._pendingTimer);
    clearTimeout(this._actionErrorTimer);
    clearInterval(this._tickTimer);
  }

  // ── Derived status ────────────────────────────────────────────
  _derivedStatus() {
    const s = this._hass?.states[this._config.status_entity]?.state;
    if (this._actionError) return this._actionError;
    if (this._pending === "on") return "booting";
    if (this._pending === "shutdown") return "shutting";
    if (this._pending === "restart") return "restarting";
    if (this._pending === "sleep") return "sleeping";
    if (s === "on") return "on";
    return "off";
  }

  _uptime() {
    const ent = this._hass?.states[this._config.status_entity];
    if (!ent || ent.state !== "on") return null;
    // Prefer an explicit uptime / last-boot sensor when configured.
    if (this._config.uptime_entity) {
      const ms = uptimeMsFromEntity(this._hass?.states[this._config.uptime_entity], Date.now());
      if (ms != null && ms >= 0) return fmtUptime(ms);
    }
    const changed = new Date(ent.last_changed).getTime();
    if (!Number.isFinite(changed)) return null;
    return fmtUptime(Date.now() - changed);
  }

  // Normalize the optional `metrics.storages` array (and the older
  // singular `metrics.storage` + `metrics.storage_total` shorthand) into a
  // clean array of { entity, attribute, total, totalAttribute, name }
  // records. `attribute` / `total_attribute` let the value (and total) come
  // from an entity attribute instead of its state — needed for HASS.Agent's
  // storage sensor, whose state is the volume label, not a number. One entry
  // per disk; supports any number for multi-disk NAS setups.
  _normalizeStorages() {
    const m = this._config.metrics || {};
    if (Array.isArray(m.storages)) {
      return m.storages.filter((s) => s && s.entity).map((s, i) => normalizeStorageItem(s, i, "Disk"));
    }
    if (m.storage) {
      return [
        normalizeStorageItem(
          {
            entity: m.storage,
            attribute: m.storage_attribute,
            total: m.storage_total,
            total_attribute: m.storage_total_attribute,
            unit: m.storage_unit,
            name: m.storage_name,
          },
          0,
          "Disk",
        ),
      ];
    }
    return [];
  }

  // Normalize the optional top-level `drives` array into clean
  // { status, temp, name } records — one per physical disk.
  // Entries without a `status` sensor are dropped.
  _normalizeDrives() {
    const d = this._config.drives;
    if (!Array.isArray(d)) return [];
    return d
      .filter((x) => x && x.status)
      .map((x, i) => ({
        status: x.status,
        temp: x.temp || null,
        name: x.name || (i === 0 ? "Drive" : `Drive ${i + 1}`),
      }));
  }

  // Normalize the optional `metrics.custom` array into clean
  // { entity, name, attribute, unit, template, bar, max, maxEntity,
  //   maxAttribute } records. Entries
  // without an `entity` are dropped. `name` stays null when unset — the
  // label then falls back to the entity's friendly_name at render time
  // (hass isn't available yet when the config is set).
  _normalizeCustomMetrics() {
    const c = this._config.metrics?.custom;
    if (!Array.isArray(c)) return [];
    return c
      .filter((x) => x && typeof x.entity === "string" && x.entity)
      .map((x) => {
        const max = Number(x.max);
        // `display` wins; the legacy `bar: true` still means a bar.
        const display =
          x.display === "bar" || x.display === "graph" || x.display === "none"
            ? x.display
            : x.bar === true
              ? "bar"
              : "none";
        return {
          entity: x.entity,
          name: x.name ? String(x.name) : null,
          attribute: x.attribute ? String(x.attribute) : null,
          unit: x.unit != null && x.unit !== "" ? String(x.unit) : null,
          template: x.template ? String(x.template) : null,
          display,
          bar: display === "bar",
          // null = "not set" (the bar then defaults to 100; {max} shows "—")
          max: Number.isFinite(max) && max > 0 ? max : null,
          maxEntity: typeof x.max_entity === "string" && x.max_entity ? x.max_entity : null,
          maxAttribute: x.max_attribute ? String(x.max_attribute) : null,
        };
      });
  }

  // Label for a custom row: explicit name → entity friendly_name → entity id.
  _customLabel(cm) {
    return cm.name || this._hass?.states[cm.entity]?.attributes?.friendly_name || cm.entity;
  }

  // Push the (possibly hass-derived) label of a custom row into its
  // .mlabel element, touching the DOM only when it actually changed.
  _syncCustomLabel(labelEl, key) {
    const cm = this._customs?.[parseInt(key.slice(7), 10)];
    if (!cm || !labelEl) return;
    const text = this._customLabel(cm);
    if (labelEl.textContent !== text) labelEl.textContent = text;
  }

  // Display string for a drive row: temperature ("38 °C") when a temp
  // sensor is configured and numeric, otherwise the capitalized status.
  _driveValue(d) {
    if (d.temp) {
      const te = this._hass?.states[d.temp];
      const n = parseFloat(te?.state);
      if (Number.isFinite(n)) {
        const unit = te.attributes?.unit_of_measurement || "°C";
        return `${Math.round(n)} ${unit}`;
      }
    }
    const st = this._hass?.states[d.status]?.state;
    if (st) return st.charAt(0).toUpperCase() + st.slice(1);
    return "—";
  }

  // Where a built-in metric (or a storage / drive volume) reads its numbers
  // from: { entityId, totalId, attribute, totalAttribute, unit, autoDetect }.
  // Storage entries are keyed by index: 'storage_0', 'storage_1', … and may
  // pull their value from an attribute; for HASS.Agent (non-numeric state)
  // the value auto-detects from the UsedSpacePercentage attribute.
  _metricSource(key) {
    const m = this._config.metrics || {};
    const fromItem = (s) =>
      s && {
        entityId: s.entity,
        totalId: s.total,
        attribute: s.attribute,
        totalAttribute: s.totalAttribute,
        unit: s.unit,
        autoDetect: !s.attribute, // only fall back when no explicit attribute
      };
    if (key === "storage" || key.startsWith("storage_")) {
      const idx = key === "storage" ? 0 : parseInt(key.slice(8), 10);
      return fromItem(this._storages?.[idx]) || null;
    }
    const plain = { totalId: null, attribute: null, totalAttribute: null, unit: null, autoDetect: false };
    const item = m[key];
    if (!item || typeof item !== "object") return null;
    return {
      ...plain,
      entityId: item.entity,
      totalId: item.total,
      attribute: item.attribute,
      totalAttribute: item.total_attribute,
      unit: item.unit,
      autoDetect: !item.attribute,
    };
  }

  // Resolve a metric entity (+ optional separate total entity) from hass
  // and delegate the parsing/formatting to computeMetricDisplay. Custom
  // metrics ('custom_0', …) go through computeCustomDisplay instead.
  _metricValue(key) {
    if (key.startsWith("custom_")) {
      const cm = this._customs?.[parseInt(key.slice(7), 10)];
      if (!cm) return null;
      const cent = this._hass?.states[cm.entity];
      if (!cent) return null;
      return computeCustomDisplay(cent, {
        attribute: cm.attribute,
        unit: cm.unit,
        template: cm.template,
        bar: cm.bar,
        max: cm.max,
        maxEntity: cm.maxEntity,
        maxEnt: cm.maxEntity ? this._hass?.states[cm.maxEntity] : null,
        maxAttribute: cm.maxAttribute,
        locale: this._hass?.locale?.language || this._hass?.language || null,
      });
    }

    const src = this._metricSource(key);
    if (!src || !src.entityId) return null;
    const ent = this._hass?.states[src.entityId];
    if (!ent) return null;
    const totalEnt = src.totalId ? this._hass?.states[src.totalId] : null;

    return computeMetricDisplay(ent, totalEnt, {
      attribute: src.attribute,
      totalAttribute: src.totalAttribute,
      totalConfigured: !!src.totalAttribute || !!src.totalId,
      autoDetect: src.autoDetect,
      unit: src.unit,
    });
  }

  // ── Graphs ────────────────────────────────────────────────────
  // Rows shown as a graph instead of a bar use their own metrics.*.display
  // setting. Feature variant only — chip shows values, tile none.
  _initGraphs() {
    const metrics = this._config.metrics || {};
    const hours = Number(this._config.graph_hours);
    this._graphHours = Number.isFinite(hours) && hours > 0 ? Math.min(720, hours) : GRAPH_DEFAULT_HOURS;

    const keys = new Set();
    for (const k of METRIC_KEYS) if (metrics[k]?.display === "graph") keys.add(k);
    (this._storages || []).forEach((st, i) => {
      if (st.display === "graph") keys.add(`storage_${i}`);
    });
    (this._customs || []).forEach((c, i) => c.display === "graph" && keys.add(`custom_${i}`));
    this._graphKeys = this._variant() === "feature" ? keys : new Set();

    // Keep already-loaded history across config edits when nothing relevant
    // changed (the visual editor re-sets the config on every keystroke).
    const prev = this._graphs || new Map();
    this._graphs = new Map();
    for (const k of this._graphKeys) {
      const spec = this._graphSpec(k);
      if (!spec) continue;
      const sig = `${spec.entity}|${spec.attribute}|${this._graphHours}`;
      const old = prev.get(k);
      if (old && old.sig === sig) {
        old.spec = spec;
        this._graphs.set(k, old);
      } else {
        this._graphs.set(k, { sig, spec, points: [], fetchedAt: 0, loading: false, failed: false });
      }
    }
  }

  // What to fetch / how to read it for one graph row.
  _graphSpec(key) {
    if (key.startsWith("custom_")) {
      const cm = this._customs?.[parseInt(key.slice(7), 10)];
      if (!cm) return null;
      return { entity: cm.entity, attribute: cm.attribute, autoDetect: false, strict: true, needAttrs: !!cm.attribute };
    }
    const src = this._metricSource(key);
    if (!src?.entityId) return null;
    return {
      entity: src.entityId,
      attribute: src.attribute,
      autoDetect: src.autoDetect,
      strict: false,
      // attributes are only requested when the value may live in one
      needAttrs: !!src.attribute || src.autoDetect,
    };
  }

  // Long periods change slowly: refresh about twice per bucket, bounded.
  _graphRefreshMs() {
    const bucket = (this._graphHours * 3_600_000) / GRAPH_POINTS;
    return Math.max(GRAPH_MIN_REFRESH_MS, Math.min(GRAPH_MAX_REFRESH_MS, bucket / 2));
  }

  _ensureGraphData(key) {
    const g = this._graphs.get(key);
    if (!g || g.loading || typeof this._hass?.callWS !== "function") return;
    if (g.fetchedAt && Date.now() - g.fetchedAt < (g.failed ? GRAPH_RETRY_MS : this._graphRefreshMs())) return;
    this._fetchGraph(g);
  }

  async _fetchGraph(g) {
    g.loading = true;
    const end = Date.now();
    const start = end - this._graphHours * 3_600_000;
    try {
      const res = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: new Date(start).toISOString(),
        end_time: new Date(end).toISOString(),
        entity_ids: [g.spec.entity],
        include_start_time_state: true,
        significant_changes_only: false,
        minimal_response: !g.spec.needAttrs,
        no_attributes: !g.spec.needAttrs,
      });
      g.points = parseHistoryPoints(res?.[g.spec.entity], g.spec);
      g.failed = false;
    } catch (_e) {
      // Keep whatever we already had; retry soon.
      g.failed = true;
    }
    g.fetchedAt = Date.now();
    g.loading = false;
    this._update();
  }

  // Current numeric value of a graph row, from the live state.
  _graphLive(key) {
    const spec = this._graphs.get(key)?.spec;
    const ent = spec && this._hass?.states[spec.entity];
    return ent ? graphValue(ent.state, ent.attributes, spec) : null;
  }

  // Top of the graph's axis (null = auto-scale to the data).
  _graphMax(key) {
    const states = this._hass?.states || {};
    if (key.startsWith("custom_")) {
      const cm = this._customs?.[parseInt(key.slice(7), 10)];
      if (!cm) return null;
      const mx = resolveCustomMax({
        max: cm.max,
        maxEntity: cm.maxEntity,
        maxEnt: cm.maxEntity ? states[cm.maxEntity] : null,
        maxAttribute: cm.maxAttribute,
      });
      if (mx != null || cm.maxEntity) return mx; // an explicit maximum, even if unreadable → auto
      const unit = cm.unit ?? (cm.attribute ? "" : (states[cm.entity]?.attributes?.unit_of_measurement ?? ""));
      return unit === "%" ? 100 : null;
    }
    const src = this._metricSource(key);
    const ent = src && states[src.entityId];
    if (!ent) return null;
    return computeMetricMax(ent, src.totalId ? states[src.totalId] : null, {
      totalAttribute: src.totalAttribute,
      totalConfigured: !!src.totalAttribute || !!src.totalId,
      unit: src.unit,
    });
  }

  _drawGraph(row, key) {
    const lineEl = row.querySelector(".gline");
    const areaEl = row.querySelector(".garea");
    const g = this._graphs.get(key);
    if (!lineEl || !areaEl || !g) return;
    this._ensureGraphData(key);

    const end = Date.now();
    const start = end - this._graphHours * 3_600_000;
    const series = resampleSeries(g.points, start, end, GRAPH_POINTS);
    const live = this._graphLive(key);
    // The right edge is "now": pin it to the live value between refreshes.
    if (live != null && series.length) series.push([end, live]);
    const paths = graphPaths(
      series,
      start,
      end,
      graphRange(
        series.map((p) => p[1]),
        this._graphMax(key),
      ),
    );
    setAttr(lineEl, "d", paths ? paths.line : "");
    setAttr(areaEl, "d", paths ? paths.area : "");
    const box = row.querySelector(".metric-graph");
    if (box) box.title = `Last ${this._graphHours} h`;
    const emptyEl = row.querySelector(".gempty");
    if (emptyEl) {
      const msg = paths ? "" : g.failed ? "History unavailable" : g.fetchedAt ? "No history" : "Loading…";
      emptyEl.hidden = !msg;
      if (emptyEl.textContent !== msg) emptyEl.textContent = msg;
    }
  }

  _clearGraph(row) {
    const lineEl = row.querySelector(".gline");
    const areaEl = row.querySelector(".garea");
    if (lineEl) setAttr(lineEl, "d", "");
    if (areaEl) setAttr(areaEl, "d", "");
    const emptyEl = row.querySelector(".gempty");
    if (emptyEl) emptyEl.hidden = true;
  }

  // ── Action handlers ──────────────────────────────────────────
  _callAction(name) {
    const a = this._actions[name];
    if (!a || !this._hass) return;
    this._hass.callService(a.domain, a.service, { entity_id: a.entity });
  }

  _setPending(p) {
    clearTimeout(this._pendingTimer);
    this._clearActionError();
    this._pending = p;
    this._pendingSince = Date.now();
    this._pendingTimer = setTimeout(() => {
      if (this._pending === p) {
        const error = p === "on" ? "boot_timeout" : `${p}_timeout`;
        this._showActionError(error);
        this._clearPending();
        this._update();
      }
    }, PENDING_TIMEOUT_MS);
    this._update();
  }
  _clearPending() {
    this._pending = null;
    clearTimeout(this._sleepTimer);
    clearTimeout(this._pendingTimer);
    this._pendingTimer = null;
  }
  _showActionError(error) {
    clearTimeout(this._actionErrorTimer);
    this._actionError = error;
    this._actionErrorTimer = setTimeout(() => {
      this._clearActionError();
      this._update();
    }, ACTION_ERROR_DISPLAY_MS);
  }
  _clearActionError() {
    this._actionError = null;
    clearTimeout(this._actionErrorTimer);
    this._actionErrorTimer = null;
  }
  _onTurnOn() {
    if (this._derivedStatus() === "on" || this._pending) return;
    // Bail before showing a pending overlay we'll never confirm.
    if (!this._actions.turn_on) return;
    this._setPending("on");
    this._callAction("turn_on");
  }
  _onSleep() {
    if (this._derivedStatus() !== "on" || this._pending) return;
    if (!this._actions.sleep) return;
    if (this._config.confirm_sleep && !this._armed.sleep) {
      this._arm("sleep");
      return;
    }
    this._disarm("sleep");
    this._setPending("sleep");
    this._callAction("sleep");
    // No reliable "sleeping" state from the binary_sensor, so clear
    // the overlay after a short display window.
    this._sleepTimer = setTimeout(() => {
      this._clearPending();
      this._update();
    }, SLEEP_DISPLAY_MS);
  }
  _onShutdown() {
    if (this._derivedStatus() === "off" || this._pending) return;
    if (!this._actions.shutdown) return;
    if (this._config.confirm_shutdown && !this._armed.shutdown) {
      this._arm("shutdown");
      return;
    }
    this._disarm("shutdown");
    this._setPending("shutdown");
    this._callAction("shutdown");
  }
  _onRestart() {
    if (this._derivedStatus() !== "on" || this._pending) return;
    if (!this._actions.restart) return;
    if (this._config.confirm_restart && !this._armed.restart) {
      this._arm("restart");
      return;
    }
    this._disarm("restart");
    this._restartDipped = false;
    this._setPending("restart");
    this._callAction("restart");
  }

  // Resolve the entity represented by an information row. More-info is
  // opened through HA's standard event so the card works in every dashboard.
  _infoEntity(key) {
    if (key === "uptime") return this._config.uptime_entity || this._config.status_entity;
    if (key === "drives_summary") return null;
    if (key.startsWith("drive_")) {
      return this._drives?.[parseInt(key.slice(6), 10)]?.status || null;
    }
    if (key.startsWith("custom_")) {
      return this._customs?.[parseInt(key.slice(7), 10)]?.entity || null;
    }
    return this._metricSource(key)?.entityId || null;
  }

  _showMoreInfo(key) {
    const entityId = this._infoEntity(key);
    if (!entityId || !this._hass?.states?.[entityId]) return;
    this.dispatchEvent(
      new CustomEvent("hass-more-info", {
        detail: { entityId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  _arm(name) {
    this._armed[name] = true;
    this._update();
    clearTimeout(this._armTimers[name]);
    this._armTimers[name] = setTimeout(() => {
      this._armed[name] = false;
      this._update();
    }, ARM_TIMEOUT_MS);
  }
  _disarm(name) {
    this._armed[name] = false;
    clearTimeout(this._armTimers[name]);
  }

  // ── Build / update ───────────────────────────────────────────
  _build() {
    const variant = this._variant();
    const html = TEMPLATES[variant](
      this._storages || [],
      this._drives || [],
      headerIcon(this._config.icon),
      this._customs || [],
      this._graphKeys || new Set(),
    );
    this.shadowRoot.innerHTML = `<style>${STYLES}</style>${html}`;

    // Apply per-card accent color override (config: `accent_color`).
    // Setting --spc-accent on the host overrides the var fallback chain
    // without bleeding into HA's --primary-color elsewhere.
    // Accepts either a CSS color string ("#7a5af8", "oklch(...)", etc)
    // or an [r, g, b] array (what HA's color_rgb picker emits).
    const ac = this._config.accent_color;
    let accentCss = null;
    if (Array.isArray(ac) && ac.length === 3) {
      accentCss = `rgb(${ac[0]}, ${ac[1]}, ${ac[2]})`;
    } else if (typeof ac === "string" && ac) {
      accentCss = ac;
    }
    if (accentCss) this.style.setProperty("--spc-accent", accentCss);
    else this.style.removeProperty("--spc-accent");

    // Wire events once.
    const $ = (sel) => this.shadowRoot.querySelector(sel);
    if (variant === "tile") {
      $(".circle").addEventListener("click", () => {
        const s = this._derivedStatus();
        if (s === "off" || s === "sleeping") this._onTurnOn();
        else if (s === "on") this._onSleep();
      });
    }
    $(".btn-on").addEventListener("click", () => this._onTurnOn());
    $(".btn-sleep").addEventListener("click", () => this._onSleep());
    $(".btn-restart").addEventListener("click", () => this._onRestart());
    $(".btn-shutdown").addEventListener("click", () => this._onShutdown());

    // Information rows use event delegation because their visibility changes
    // during updates, while the shadow DOM itself is only rebuilt on config.
    if (!this._infoEventsWired) {
      this._infoEventsWired = true;
      this.shadowRoot.addEventListener("click", (ev) => {
        const row = ev.target.closest?.("[data-info-key]");
        if (row) {
          this._showMoreInfo(row.dataset.infoKey);
          row.blur();
        }
      });
      this.shadowRoot.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        const row = ev.target.closest?.("[data-info-key]");
        if (!row) return;
        ev.preventDefault();
        this._showMoreInfo(row.dataset.infoKey);
      });
    }

    // Tick uptime + animations.
    clearInterval(this._tickTimer);
    this._tickTimer = setInterval(() => this._update(), 1000);
  }

  _variant() {
    const v = this._config?.variant;
    if (v === "feature" || v === "chip") return v;
    return "tile";
  }

  _update() {
    if (!this.shadowRoot.firstChild) return;
    const status = this._derivedStatus();
    const meta = META[status];
    const variant = this._variant();

    const root = this.shadowRoot.querySelector(".card");
    root.classList.toggle("is-on", status === "on");
    root.classList.toggle("is-sleeping", status === "sleeping");
    root.classList.toggle("is-off", status === "off");
    root.classList.toggle("action-error", meta.tone === "alert" && !meta.pulse);

    // Track whether any action button is visible — used to collapse
    // the entire actions row + adjust the previous section's bottom
    // padding so the card has equal side/bottom gaps when buttons are
    // hidden (behaves like a pure status monitor).
    const vis = {
      on: !!this._actions.turn_on,
      sleep: !!this._actions.sleep,
      restart: !!this._actions.restart,
      shutdown: !!this._actions.shutdown,
    };
    const anyBtn = vis.on || vis.sleep || vis.restart || vis.shutdown;
    root.classList.toggle("no-actions", !anyBtn);

    // Name + status text
    root.querySelector(".name").textContent = this._config.name;
    const labelEl = root.querySelector(".status .label");
    labelEl.textContent = meta.label;
    const statusEl = root.querySelector(".status");
    statusEl.classList.toggle("live", meta.tone === "live");
    statusEl.classList.toggle("warm", meta.tone === "warm");
    statusEl.classList.toggle("alert", meta.tone === "alert");
    statusEl.classList.toggle("idle", meta.tone === "idle");

    // Dot
    const dot = root.querySelector(".status .dot");
    dot.classList.remove("live", "warm", "alert", "idle", "pulse");
    dot.classList.add(meta.tone);
    if (meta.pulse) dot.classList.add("pulse");

    // Animated "…" for transitional states
    const anim = root.querySelector(".status .anim");
    anim.className = "anim" + (meta.pulse ? " dots" : "");

    // Pulsing ring around the icon during transitional states
    // (feature + chip have one; tile uses a different icon shape).
    const ring = root.querySelector(".icon-box .ring");
    if (ring) {
      if (meta.pulse) {
        ring.style.display = "";
        ring.className = "ring " + meta.tone;
      } else {
        ring.style.display = "none";
      }
    }

    // Feature-only: uptime + metric bars
    if (variant === "feature") {
      const up = this._uptime();
      const uval = root.querySelector(".uptime .uval");
      uval.textContent = up ?? "—";
      uval.classList.toggle("dim", !up);

      const isOn = status === "on";
      const storageKeys = (this._storages || []).map((_, i) => `storage_${i}`);
      const customKeys = (this._customs || []).map((_, i) => `custom_${i}`);
      [...METRIC_KEYS, ...storageKeys, ...customKeys].forEach((k) => {
        const row = root.querySelector(`.metric[data-key="${k}"]`);
        if (!row) return;
        // Only configured metrics are rendered.
        let enabled;
        if (k.startsWith("storage_")) {
          enabled = true;
        } else if (k.startsWith("custom_")) {
          enabled = true;
        } else {
          enabled = !!this._config.metrics?.[k];
        }
        row.style.display = enabled ? "" : "none";
        if (!enabled) return;
        if (k.startsWith("custom_")) this._syncCustomLabel(row.querySelector(".mlabel"), k);
        const m = this._metricValue(k);
        const valEl = row.querySelector(".mval");
        const fillEl = row.querySelector(".fill"); // absent on graph rows and bar-less custom rows
        const asGraph = this._graphKeys?.has(k);
        if (isOn && m) {
          valEl.textContent = m.displayValue;
          if (asGraph) this._drawGraph(row, k);
          else if (fillEl) fillEl.style.width = m.barPct != null ? `${m.barPct}%` : "0%";
        } else {
          valEl.textContent = "—";
          if (asGraph) this._clearGraph(row);
          else if (fillEl) fillEl.style.width = "0%";
        }
      });

      // Per-drive health rows.
      (this._drives || []).forEach((d, i) => {
        const row = root.querySelector(`.drive[data-key="drive_${i}"]`);
        if (!row) return;
        const enabled = true;
        row.style.display = enabled ? "" : "none";
        if (!enabled) return;
        const dot = row.querySelector(".ddot");
        const valEl = row.querySelector(".dval");
        if (isOn) {
          const healthy = driveHealthy(this._hass?.states[d.status]?.state, this._healthyStates);
          dot.classList.toggle("ok", healthy);
          dot.classList.toggle("bad", !healthy);
          valEl.textContent = this._driveValue(d);
        } else {
          dot.classList.remove("ok", "bad");
          valEl.textContent = "—";
        }
      });
    }

    // Chip-only: inline uptime + mini stats (cpu/ram/gpu + temps + disks + custom)
    if (variant === "chip") {
      const up = this._uptime();
      const sep = root.querySelector(".uptime-sep");
      const upEl = root.querySelector(".uptime-inline");
      if (up && status === "on") {
        sep.style.display = "";
        upEl.style.display = "";
        upEl.textContent = `up ${up}`;
      } else {
        sep.style.display = "none";
        upEl.style.display = "none";
      }

      const mini = root.querySelector(".mini-stats");
      const isOn = status === "on";
      let anyMini = false;
      const chipStorageKeys = (this._storages || []).map((_, i) => `storage_${i}`);
      const chipCustomKeys = (this._customs || []).map((_, i) => `custom_${i}`);
      [...METRIC_KEYS, ...chipStorageKeys, ...chipCustomKeys].forEach((k) => {
        const stat = mini.querySelector(`.mini-stat[data-key="${k}"]`);
        if (!stat) return;
        let enabled;
        if (k.startsWith("storage_")) {
          enabled = true;
        } else if (k.startsWith("custom_")) {
          enabled = true;
        } else {
          enabled = !!this._config.metrics?.[k];
        }
        stat.style.display = enabled ? "" : "none";
        if (!enabled) return;
        anyMini = true;
        const isCustom = k.startsWith("custom_");
        if (isCustom) this._syncCustomLabel(stat.querySelector(".mlabel"), k);
        const cell = stat.querySelector(".mval");
        const m = isOn ? this._metricValue(k) : null;
        // Chip uses the compact form (no "/ total" suffix, no template) to
        // fit the narrower mini-stat column.
        cell.textContent = m ? m.compactValue : "—";
        if (isCustom) cell.title = m ? m.displayValue : "";
      });

      // Drive summary mini-stat (healthy/total), red if any unhealthy.
      if ((this._drives || []).length) {
        const stat = mini.querySelector('.mini-stat[data-key="drives_summary"]');
        if (stat) {
          const enabled = true;
          stat.style.display = enabled ? "" : "none";
          if (enabled) {
            anyMini = true;
            const cell = stat.querySelector(".mval");
            if (isOn) {
              const total = this._drives.length;
              const healthy = this._drives.filter((d) =>
                driveHealthy(this._hass?.states[d.status]?.state, this._healthyStates),
              ).length;
              cell.textContent = `${healthy}/${total}`;
              cell.classList.toggle("bad", healthy < total);
            } else {
              cell.textContent = "—";
              cell.classList.remove("bad");
            }
          }
        }
      }
      mini.style.display = isOn && anyMini ? "" : "none";
    }

    // Button states
    const onBtn = root.querySelector(".btn-on");
    const sleepBtn = root.querySelector(".btn-sleep");
    const restartBtn = root.querySelector(".btn-restart");
    const shutBtn = root.querySelector(".btn-shutdown");

    // Show/hide each action button per config. Remaining buttons fill
    // the row via flex: 1. The actions row + chip divider are hidden
    // by the .no-actions class on .card (set above), so no inline
    // style override is needed for them — only the individual buttons.
    onBtn.style.display = vis.on ? "" : "none";
    sleepBtn.style.display = vis.sleep ? "" : "none";
    restartBtn.style.display = vis.restart ? "" : "none";
    shutBtn.style.display = vis.shutdown ? "" : "none";

    const off = status === "off";
    const on = status === "on";
    const slp = status === "sleeping";
    const pend = this._pending != null;

    setBtn(onBtn, {
      disabled: on || pend,
      primary: off || slp,
      busy: this._pending === "on",
      iconKey: "power",
      label: variant === "tile" ? "On" : "Turn on",
    });
    setBtn(sleepBtn, {
      disabled: !on || pend,
      primary: false,
      busy: this._pending === "sleep",
      armed: this._armed.sleep,
      iconKey: "moon",
      label: "Sleep",
      armedLabel: this._config.confirm_sleep ? "Confirm?" : null,
    });
    setBtn(restartBtn, {
      disabled: !on || pend,
      busy: this._pending === "restart",
      armed: this._armed.restart,
      iconKey: "restart",
      label: "Restart",
      armedLabel: this._config.confirm_restart ? "Confirm?" : null,
    });
    setBtn(shutBtn, {
      disabled: off || pend,
      primary: false,
      danger: true,
      armed: this._armed.shutdown,
      busy: this._pending === "shutdown",
      iconKey: "power",
      // Always "Shut down" — "Off" on the tile reads as a state toggle
      // and obscures the destructive intent. The .danger color + the
      // confirm flow are the safety signals.
      label: "Shut down",
      armedLabel: this._config.confirm_shutdown ? "Confirm?" : null,
    });
  }
}

// ── Templates ───────────────────────────────────────────────────────
// One static string per variant. The shadow DOM is replaced wholesale
// on each setConfig; _update() then fills in the text/classes.

const TEMPLATES = {
  tile: (_storages, _drives, iconSvg) => `
    <ha-card class="card tile">
      <div class="head">
        <button class="circle" title="Toggle">${iconSvg}</button>
        <div style="min-width:0; flex:1;">
          <div class="name"></div>
          <div class="status"><span class="dot"></span><span class="label"></span><span class="anim"></span></div>
        </div>
      </div>
      <div class="actions">
        <button class="btn btn-on compact" title="Turn on"></button>
        <button class="btn btn-sleep compact" title="Sleep"></button>
        <button class="btn btn-restart compact" title="Restart"></button>
        <button class="btn btn-shutdown danger compact" title="Shut down"></button>
      </div>
    </ha-card>
  `,

  chip: (storages, drives, iconSvg, customs = []) => `
    <ha-card class="card chip">
      <div class="head">
        <div class="icon-box chip-icon">${iconSvg}<span class="ring" style="display:none"></span></div>
        <div class="meta">
          <div class="name"></div>
          <div class="status">
            <span class="dot"></span>
            <span class="label"></span>
            <span class="uptime-sep" style="display:none">·</span>
            <span class="uptime-inline" style="display:none"></span>
            <span class="anim"></span>
          </div>
        </div>
        <div class="mini-stats" style="display:none">
          ${METRIC_KEYS.map(
            (k) => `
          <div class="mini-stat info-row" data-key="${k}" data-info-key="${k}" role="button" tabindex="0">
            <div class="mlabel">${METRIC_LABELS[k]}</div>
            <div class="mval">—</div>
          </div>
          `,
          ).join("")}
          ${storages
            .map(
              (s, i) => `
          <div class="mini-stat info-row" data-key="storage_${i}" data-info-key="storage_${i}" role="button" tabindex="0">
            <div class="mlabel">${escapeHtml(s.name).toUpperCase()}</div>
            <div class="mval">—</div>
          </div>
          `,
            )
            .join("")}
          ${customs
            .map(
              (_c, i) => `
          <div class="mini-stat custom info-row" data-key="custom_${i}" data-info-key="custom_${i}" role="button" tabindex="0">
            <div class="mlabel"></div>
            <div class="mval">—</div>
          </div>
          `,
            )
            .join("")}
          ${
            drives.length
              ? `
          <div class="mini-stat" data-key="drives_summary">
            <div class="mlabel">DRIVES</div>
            <div class="mval">—</div>
          </div>
          `
              : ""
          }
        </div>
      </div>
      <div class="divider"></div>
      <div class="actions">
        <button class="btn btn-on" title="Turn on"></button>
        <button class="btn btn-sleep" title="Sleep"></button>
        <button class="btn btn-restart" title="Restart"></button>
        <button class="btn btn-shutdown danger" title="Shut down"></button>
      </div>
    </ha-card>
  `,

  feature: (storages, drives, iconSvg, customs = [], graphKeys = new Set()) => `
    <ha-card class="card feature">
      <div class="head">
        <div class="icon-box lg">${iconSvg}<span class="ring" style="display:none"></span></div>
        <div class="meta">
          <div class="name"></div>
          <div class="status"><span class="dot"></span><span class="label"></span><span class="anim"></span></div>
        </div>
        <div class="uptime info-row" data-info-key="uptime" role="button" tabindex="0">
          <div class="ulabel">Uptime</div>
          <div class="uval">—</div>
        </div>
      </div>

      <div class="metrics">
        ${METRIC_KEYS.map((k) => metricRow(k, METRIC_LABELS[k], false, { graph: graphKeys.has(k) })).join("")}
        ${storages
          .map((s, i) =>
            metricRow(`storage_${i}`, escapeHtml(s.name).toUpperCase(), false, {
              graph: graphKeys.has(`storage_${i}`),
            }),
          )
          .join("")}
        ${customs
          .map((c, i) =>
            metricRow(`custom_${i}`, "", false, {
              custom: true,
              bar: c.display === "bar",
              graph: graphKeys.has(`custom_${i}`),
            }),
          )
          .join("")}
        ${drives.map((d, i) => driveGroup(d, i)).join("")}
      </div>

      <div class="actions">
        <button class="btn btn-on" title="Turn on"></button>
        <button class="btn btn-sleep" title="Sleep"></button>
        <button class="btn btn-restart" title="Restart"></button>
        <button class="btn btn-shutdown danger" title="Shut down"></button>
      </div>
    </ha-card>
  `,
};

// Normalize one storage config record into the shape _metricValue expects.
function normalizeStorageItem(s, i, base) {
  return {
    entity: s.entity,
    attribute: s.attribute || null,
    total: s.total || null,
    totalAttribute: s.total_attribute || null,
    unit: s.unit || null,
    display: s.display === "graph" || s.display === "bar" ? s.display : null,
    name: s.name || (i === 0 ? base : `${base} ${i + 1}`),
  };
}

// One metric row. `opts.custom` marks a custom-metric row (label filled in
// at update time, free-text value styling). The visual is a progress bar by
// default; `opts.graph` swaps it for a sparkline and `opts.bar === false`
// drops it entirely (value only).
function metricRow(key, label, nested, opts = {}) {
  const kind = opts.graph ? "graph" : opts.bar === false ? "none" : "bar";
  const viz =
    kind === "graph"
      ? '<div class="metric-graph"><svg viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"><path class="garea" d=""/><path class="gline" d=""/></svg><span class="gempty" hidden></span></div>'
      : kind === "bar"
        ? '<div class="metric-bar"><div class="fill"></div></div>'
        : "";
  return `
    <div class="metric info-row${nested ? " nested" : ""}${opts.custom ? " custom" : ""}${kind === "none" ? " no-bar" : ""}${kind === "graph" ? " has-graph" : ""}" data-key="${key}" data-info-key="${key}" role="button" tabindex="0">
      <div class="metric-head">
        <span class="mlabel">${label}</span>
        <span class="mval">—</span>
      </div>
      ${viz}
    </div>
  `;
}

function driveRow(key, label) {
  return `
    <div class="drive info-row" data-key="${key}" data-info-key="${key}" role="button" tabindex="0">
      <span class="ddot"></span>
      <span class="dname">${label}</span>
      <span class="dval">—</span>
    </div>
  `;
}

// A drive rendered as a health row. Used by the feature variant.
function driveGroup(d, i) {
  return driveRow(`drive_${i}`, escapeHtml(d.name).toUpperCase());
}

// setAttribute that skips the DOM write when nothing changed (graphs are
// redrawn every second).
function setAttr(el, name, value) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

function setBtn(btn, opts) {
  // Idempotent flags — toggling to same value is a no-op.
  btn.disabled = !!opts.disabled;
  btn.classList.toggle("primary", !!opts.primary);
  btn.classList.toggle("danger", !!opts.danger);
  btn.classList.toggle("armed", !!opts.armed);
  // innerHTML rewrites are the expensive part — skip when the visible
  // content hasn't changed (called every 1s by the uptime ticker).
  const key = opts.busy ? "__busy" : `${opts.label}|${opts.armedLabel || ""}|${opts.iconKey}`;
  if (btn._key === key) return;
  btn._key = key;
  if (opts.busy) {
    btn.innerHTML = ICONS.spinner;
    return;
  }
  const icon = ICONS[opts.iconKey] || "";
  // Build a label stack so the button's width is determined by the
  // LONGER of (label, armedLabel) and never shifts when armed.
  // If armedLabel is null (confirmation disabled), render the normal
  // label alone — still inside the stack for layout consistency.
  const normal = `<span class="lbl normal">${icon}<span>${opts.label}</span></span>`;
  const confirm = opts.armedLabel ? `<span class="lbl confirm">${icon}<span>${opts.armedLabel}</span></span>` : "";
  btn.innerHTML = `<span class="lbl-stack">${normal}${confirm}</span>`;
}

// ── Visual editor ───────────────────────────────────────────────────
// HA renders this in the dashboard card-edit dialog. The main part uses
// HA's built-in <ha-form> with a schema — gives us entity pickers, a color
// picker, toggles, dropdowns for free. <ha-form> only exists inside
// the HA frontend; outside HA (e.g. on the GitHub Pages demo) this
// class is unused.
//
// Storage, custom metrics and drives get
// dedicated dynamic lists modelled on the official Entities card editor:
// drag handle · entity picker · remove · edit (pencil), an "Add" button,
// and a sub-editor (back arrow, `{}` code toggle) for the per-row fields.
// Reordering is a small native pointer-events drag (no dependency on HA's
// lazy-loaded SortableJS), so it works on touch too.

// Bar or graph, for the Feature card (chip and tile only show values).
const DISPLAY_SELECT = {
  select: {
    mode: "dropdown",
    options: [
      { value: "bar", label: "Progress bar" },
      { value: "graph", label: "Graph" },
    ],
  },
};

const EDITOR_SCHEMA = [
  {
    name: "variant",
    selector: {
      select: {
        mode: "dropdown",
        options: [
          { value: "tile", label: "Tile (compact)" },
          { value: "chip", label: "Chip (Mushroom-style)" },
          { value: "feature", label: "Feature (full, with metric bars)" },
        ],
      },
    },
  },
  { name: "name", selector: { text: {} } },
  { name: "status_entity", selector: { entity: { domain: ["binary_sensor", "sensor", "switch"] } } },
  { name: "uptime_entity", selector: { entity: { domain: "sensor" } } },

  {
    type: "expandable",
    title: "Actions",
    icon: "mdi:gesture-tap",
    schema: [
      { name: "turn_on", selector: { entity: { domain: ["switch", "script", "button", "input_button"] } } },
      { name: "sleep", selector: { entity: { domain: ["button", "script", "input_button"] } } },
      { name: "restart", selector: { entity: { domain: ["button", "script", "input_button"] } } },
      { name: "shutdown", selector: { entity: { domain: ["button", "script", "input_button"] } } },
    ],
  },

  {
    type: "expandable",
    title: "Confirmation",
    icon: "mdi:shield-check",
    schema: [
      { name: "confirm_shutdown", selector: { boolean: {} } },
      { name: "confirm_sleep", selector: { boolean: {} } },
      { name: "confirm_restart", selector: { boolean: {} } },
    ],
  },

  {
    type: "expandable",
    title: "Appearance",
    icon: "mdi:palette",
    schema: [
      {
        name: "icon",
        selector: { icon: {} },
      },
      { name: "accent_color", selector: { color_rgb: {} } },
      {
        name: "graph_hours",
        selector: { number: { min: 1, max: 720, step: 1, mode: "box", unit_of_measurement: "h" } },
      },
    ],
  },

  {
    type: "expandable",
    title: "Metrics (Chip & Feature)",
    icon: "mdi:chart-line",
    schema: [
      // Each metric: its sensor, then how the Feature card draws it.
      ...METRIC_KEYS.flatMap((k, index) => [
        ...(index > 0 ? [{ name: `_metrics_divider_${k}`, type: "divider" }] : []),
        { name: `_metric_${k}`, selector: { entity: { domain: "sensor" } } },
        ...(k === "ram_usage" ? [{ name: "_metric_ram_usage_total", selector: { entity: { domain: "sensor" } } }] : []),
        { name: `_display_${k}`, selector: DISPLAY_SELECT },
      ]),
    ],
  },
];

const EDITOR_LABELS = {
  variant: "Variant",
  name: "Name",
  status_entity: "Status sensor (on = device is reachable)",
  uptime_entity: "Uptime / last-boot sensor (optional, more accurate)",
  turn_on: "Turn on action",
  sleep: "Sleep action",
  restart: "Restart action (e.g. NAS reboot button)",
  shutdown: "Shutdown action",
  confirm_shutdown: "Require confirm for Shutdown",
  confirm_sleep: "Require confirm for Sleep",
  confirm_restart: "Require confirm for Restart",
  _display_cpu_usage: "CPU usage · display (bar or graph)",
  _display_cpu_temp: "CPU temperature · display (bar or graph)",
  _display_gpu_usage: "GPU usage · display (bar or graph)",
  _display_gpu_temp: "GPU temperature · display (bar or graph)",
  _display_ram_usage: "RAM · display (bar or graph)",
  graph_hours: "Graph period (hours, default 24)",
  accent_color: "Accent color (overrides theme)",
  icon: "Header icon",
  _metric_cpu_usage: "CPU usage sensor (percent)",
  _metric_cpu_temp: "CPU temperature sensor (°C)",
  _metric_gpu_usage: "GPU usage sensor (percent or load)",
  _metric_gpu_temp: "GPU temperature sensor (°C)",
  _metric_ram_usage: "RAM sensor (used / percent)",
  _metric_ram_usage_total: "RAM total sensor (omit to show percent only)",
};

// ── Custom metrics editor: schemas, labels, icons ───────────────────

// Each list row is a single entity picker (like the official Entities card).
const CUSTOM_ROW_SCHEMA = [{ name: "entity", required: true, selector: { entity: {} } }];

// Sub-editor form. `display` picks value only / progress bar / graph. The
// maximum only makes sense — and only shows — with a bar or a graph.
// `max_source` is a UI-only switch (never saved): a fixed value, or an
// entity (+ optional attribute) like the disks' `total`.
function customRowSchema(display, maxMode) {
  const schema = [
    { name: "entity", required: true, selector: { entity: {} } },
    { name: "name", selector: { text: {} } },
    { name: "attribute", selector: { attribute: {} }, context: { filter_entity: "entity" } },
    { name: "unit", selector: { text: {} } },
    { name: "template", selector: { text: {} } },
    {
      name: "display",
      selector: {
        select: {
          mode: "dropdown",
          options: [
            { value: "none", label: "Value only" },
            { value: "bar", label: "Progress bar" },
            { value: "graph", label: "Graph" },
          ],
        },
      },
    },
  ];
  if (display === "bar" || display === "graph") {
    schema.push({
      name: "max_source",
      selector: {
        select: {
          mode: "dropdown",
          options: [
            { value: "value", label: "Fixed value" },
            { value: "entity", label: "Entity" },
          ],
        },
      },
    });
    if (maxMode === "entity") {
      schema.push(
        { name: "max_entity", selector: { entity: {} } },
        { name: "max_attribute", selector: { attribute: {} }, context: { filter_entity: "max_entity" } },
      );
    } else {
      schema.push({ name: "max", selector: { number: { mode: "box", min: 0, step: "any" } } });
    }
  }
  return schema;
}

const CUSTOM_ROW_LABELS = {
  entity: "Entity",
  name: "Name",
  attribute: "Attribute",
  unit: "Unit",
  template: "Template",
  display: "Display",
  max_source: "Maximum",
  max: "Maximum value",
  max_entity: "Maximum entity",
  max_attribute: "Maximum attribute",
};

const CUSTOM_ROW_HELPERS = {
  name: "Defaults to the entity's name",
  attribute: "Read an attribute instead of the state",
  unit: "Overrides the entity's unit (numeric values only)",
  template: 'Placeholders: {value} and {max}, e.g. "{value} / {max}"',
  display: "Bar and graph need a numeric value (graphs also need the entity to be recorded)",
  max_source: "Full scale of the bar / top of the graph",
  max: "Bar default: 100 · graph default: auto-scale",
  max_entity: "Same unit as the value (e.g. a total-size sensor)",
  max_attribute: "Read an attribute instead of the state",
};

// Keys the sub-editor form manages; any other key found in a row's YAML is
// carried over untouched when the row is saved from the form.
const CUSTOM_ROW_KEYS = [
  "entity",
  "name",
  "attribute",
  "unit",
  "template",
  "display",
  "bar",
  "max",
  "max_entity",
  "max_attribute",
];

// Material Design Icons paths (24×24) — the same glyphs HA's own editors use.
const EDITOR_ICONS = {
  drag: "M21 11H3V9H21V11M21 15H3V13H21V15Z",
  close:
    "M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z",
  pencil:
    "M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z",
  back: "M15.41,16.58L10.83,12L15.41,7.41L14,6L8,12L14,18L15.41,16.58Z",
  add: "M3 16H10V14H3M18 14V10H16V14H12V16H16V20H18V16H22V14M14 6H3V8H14M14 10H3V12H14V10Z",
  code: "M8,3A2,2 0 0,0 6,5V9A2,2 0 0,1 4,11H3V13H4A2,2 0 0,1 6,15V19A2,2 0 0,0 8,21H10V19H8V14A2,2 0 0,0 6,12A2,2 0 0,0 8,10V5H10V3M16,3A2,2 0 0,1 18,5V9A2,2 0 0,0 20,11H21V13H20A2,2 0 0,0 18,15V19A2,2 0 0,1 16,21H14V19H16V14A2,2 0 0,1 18,12A2,2 0 0,1 16,10V5H14V3H16Z",
  list: "M19 5V19H5V5H19M19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3M11 7H17V9H11V7M11 11H17V13H11V11M11 15H17V17H11V15M7 7H9V9H7V7M7 11H9V13H7V11M7 15H9V17H7V15Z",
};
const eIcon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${EDITOR_ICONS[name]}"/></svg>`;

// HA's own icon button (core component, always loaded in the frontend) so
// size, hover and ripple match the official editors exactly.
function haIconButton(icon, label, cls) {
  const b = document.createElement("ha-icon-button");
  b.className = cls;
  b.path = EDITOR_ICONS[icon];
  b.label = label;
  return b;
}

const EDITOR_STYLES = `
:host { display: block; }
.wrap { display: block; padding: 4px 0; }

/* Section heading + hint (same 16px heading as "Entities (required)"). */
.cm-section { margin-top: 24px; }
.cm-title {
  margin: 0 0 4px; font-size: 16px; font-weight: 500; line-height: 24px;
  color: var(--primary-text-color);
}
.cm-hint { font-size: 12px; line-height: 1.5; color: var(--secondary-text-color); margin-bottom: 8px; }
.cm-hint code {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  background: color-mix(in srgb, var(--primary-text-color) 10%, transparent);
  padding: 1px 4px; border-radius: 4px;
}

/* Rows — same anatomy as the Entities card editor:
   24px handle + 8px gap · picker (grows) · 36px remove · 36px edit. */
.cm-list { display: flex; flex-direction: column; gap: 8px; }
.cm-row { display: flex; align-items: center; position: relative; }
.cm-row.shifting { transition: transform 150ms ease; }
.cm-row.dragging {
  z-index: 2; transition: none; border-radius: 12px;
  background: var(--card-background-color, var(--primary-background-color, #1c1c1c));
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
}
.handle {
  display: flex; align-items: center; flex-shrink: 0;
  padding-inline-end: 8px;
  color: var(--primary-text-color);
  cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none;
}
.cm-row.dragging .handle { cursor: grabbing; }
.handle svg { display: block; width: 24px; height: 24px; fill: currentColor; pointer-events: none; }
.row-form { flex: 1; min-width: 0; display: block; }
.rm, .ed, .cancel {
  --mdc-icon-button-size: 36px;
  --ha-icon-button-size: 36px;
  flex-shrink: 0;
  color: var(--secondary-text-color);
}

/* "Add entity" sits under the pickers, aligned with their left edge
   (24px handle + 8px gap = 32px). */
.cm-add { margin-top: 8px; padding-inline-start: 32px; display: flex; align-items: center; }
.cm-add ha-form { flex: 1; min-width: 0; display: block; }
/* Fallback when ha-button isn't available: a 32px tonal pill. */
button.add-btn {
  display: inline-flex; align-items: center; gap: 8px;
  height: 32px; padding: 0 12px 0 10px;
  border: none; border-radius: 999px; cursor: pointer;
  font-size: 14px; font-weight: 500;
  font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
  color: var(--primary-color);
  background: color-mix(in srgb, var(--primary-color) 18%, transparent);
}
button.add-btn:hover { background: color-mix(in srgb, var(--primary-color) 26%, transparent); }
button.add-btn svg { width: 18px; height: 18px; fill: currentColor; }

/* Sub-editor header: [48px back] [title] [48px code toggle], no gaps. */
.sub-head { display: flex; align-items: center; margin-bottom: 8px; }
.sub-title {
  flex: 1; min-width: 0; font-size: 16px; font-weight: 500; line-height: 24px;
  color: var(--primary-text-color);
}
.sub-body { display: block; }
.sub-body ha-form { display: block; }
textarea.json {
  width: 100%; min-height: 220px; box-sizing: border-box; resize: vertical;
  padding: 10px; border-radius: 8px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px;
  color: var(--primary-text-color);
  background: var(--card-background-color, transparent);
  border: 1px solid var(--divider-color, rgba(127, 127, 127, 0.4));
}
textarea.json.invalid { border-color: var(--error-color, #db4437); }
`;

// ── Dynamic list editors ────────────────────────────────────────────
// Storage, custom metrics and drives are all
// edited the same way: a list of rows (drag handle · picker · remove ·
// pencil), an "Add" button and a per-row sub-editor. LIST_DEFS describes a
// list, SUB_DEFS the sub-editor form of one row.

const SENSOR_SELECTOR = { entity: { domain: "sensor" } };

function listDef(def) {
  return { ...def, rowSchema: [{ name: def.key, required: true, selector: def.selector }] };
}

const LIST_DEFS = {
  storages: listDef({
    title: "Storage",
    hint: "One bar (or graph) per disk, for the Chip &amp; Feature variants. Pick the sensor, then use the pencil to set a name, a value attribute, a total, a unit or a graph.",
    addLabel: "Add storage",
    key: "entity",
    pickerLabel: "Used / percent sensor",
    selector: SENSOR_SELECTOR,
  }),
  custom: listDef({
    title: "Custom metrics",
    hint: "Extra rows for the Chip &amp; Feature variants. Pick an entity, then use the pencil to set a name, attribute, unit, <code>{value}</code> template or a progress bar.",
    addLabel: "Add entity",
    key: "entity",
    pickerLabel: "Entity",
    selector: { entity: {} },
  }),
  drives: listDef({
    title: "Drives (NAS health)",
    hint: "One row per physical drive: the Feature card shows each one, the Chip a healthy/total summary. Pick the status sensor, then use the pencil for a temperature sensor and a name.",
    addLabel: "Add drive",
    key: "status",
    pickerLabel: "Status sensor",
    selector: SENSOR_SELECTOR,
  }),
};

// Lists shown on the main view, in the order the Feature card draws them.
const MAIN_LISTS = ["storages", "custom", "drives"];

// Pre-1.9 single-disk shorthand (metrics.storage + metrics.storage_*). The
// card still reads it; the editor surfaces it as one row of the Storage list
// and drops it as soon as that list is edited.
const LEGACY_STORAGE_KEYS = [
  "storage",
  "storage_attribute",
  "storage_total",
  "storage_total_attribute",
  "storage_unit",
  "storage_name",
];

function legacyStorages(m) {
  if (!m || !m.storage) return [];
  const item = { entity: m.storage };
  if (m.storage_name) item.name = m.storage_name;
  if (m.storage_attribute) item.attribute = m.storage_attribute;
  if (m.storage_total) item.total = m.storage_total;
  if (m.storage_total_attribute) item.total_attribute = m.storage_total_attribute;
  if (m.storage_unit) item.unit = m.storage_unit;
  return [item];
}

const isFilled = (x) => x !== undefined && x !== null && x !== "";
function copyFilled(out, src, keys) {
  for (const k of keys) if (isFilled(src[k])) out[k] = src[k];
  return out;
}

// Sub-editor of a storage item.
function storageSubDef({ title, base, withDisplay }) {
  const textKeys = ["name", "attribute", "total", "total_attribute", "unit"];
  return {
    title,
    keys: ["entity", ...textKeys, ...(withDisplay ? ["display"] : [])],
    labels: {
      entity: "Used / percent sensor",
      name: "Name",
      attribute: "Value attribute",
      total: "Total sensor",
      total_attribute: "Total attribute",
      unit: "Unit",
      display: "Display",
    },
    helpers: {
      name: `Defaults to "${base}", "${base} 2"…`,
      attribute: "Read this attribute instead of the state (e.g. UsedSpacePercentage). Blank = state",
      total: "Optional — omit for a percent display",
      total_attribute: "Optional — total read from an attribute of the same entity (e.g. TotalSizeMB)",
      unit: "Unit the values are ALREADY in, e.g. MB (not the display unit — the card auto-scales to GB/TB)",
      display: "Progress bar or graph (Feature card)",
    },
    schemaKey: () => "static",
    schema: () => [
      { name: "entity", required: true, selector: SENSOR_SELECTOR },
      { name: "name", selector: { text: {} } },
      { name: "attribute", selector: { attribute: {} }, context: { filter_entity: "entity" } },
      { name: "total", selector: SENSOR_SELECTOR },
      { name: "total_attribute", selector: { attribute: {} }, context: { filter_entity: "entity" } },
      { name: "unit", selector: { text: {} } },
      ...(withDisplay ? [{ name: "display", selector: DISPLAY_SELECT }] : []),
    ],
    toForm: (item) => ({
      entity: item.entity || "",
      name: item.name,
      attribute: item.attribute,
      total: item.total,
      total_attribute: item.total_attribute,
      unit: item.unit,
      ...(withDisplay ? { display: item.display === "graph" ? "graph" : "bar" } : {}),
    }),
    fromForm: (v) => {
      const out = copyFilled({ entity: v.entity || "" }, v, textKeys);
      if (withDisplay && v.display === "graph") out.display = "graph";
      return out;
    },
  };
}

// `ui` = { maxMode } — the UI-only "fixed value / entity" switch of the
// custom-metric maximum (only used by the custom sub-editor).
const SUB_DEFS = {
  storages: storageSubDef({ title: "Storage editor", base: "Disk", withDisplay: true }),

  drives: {
    title: "Drive editor",
    keys: ["status", "temp", "name"],
    labels: { status: "Status sensor", temp: "Temperature sensor", name: "Name" },
    helpers: {
      status: "Healthy when its state is normal / ok / healthy / good (see healthy_states)",
      temp: "Optional — shown instead of the status text",
      name: 'Defaults to "Drive", "Drive 2"…',
    },
    schemaKey: () => "static",
    schema: () => [
      { name: "status", required: true, selector: SENSOR_SELECTOR },
      { name: "temp", selector: SENSOR_SELECTOR },
      { name: "name", selector: { text: {} } },
    ],
    toForm: (item) => ({ status: item.status || "", temp: item.temp, name: item.name }),
    fromForm: (v) => copyFilled({ status: v.status || "" }, v, ["temp", "name"]),
  },

  custom: {
    title: "Custom metric editor",
    keys: CUSTOM_ROW_KEYS,
    labels: CUSTOM_ROW_LABELS,
    helpers: CUSTOM_ROW_HELPERS,
    // A legacy `bar: true` row opens as "Progress bar".
    display: (item) => (item.display === "bar" || item.display === "graph" ? item.display : item.bar ? "bar" : "none"),
    // The schema changes only when the display or the maximum source flips.
    schemaKey(item, ui) {
      return `${this.display(item)}|${ui.maxMode}`;
    },
    schema(item, ui) {
      return customRowSchema(this.display(item), ui.maxMode);
    },
    toForm(item, ui) {
      return {
        entity: item.entity || "",
        name: item.name,
        attribute: item.attribute,
        unit: item.unit,
        template: item.template,
        display: this.display(item),
        max_source: ui.maxMode,
        max: item.max,
        max_entity: item.max_entity,
        max_attribute: item.max_attribute,
      };
    },
    // Empty fields are dropped and the maximum only kept with a bar / graph.
    fromForm(v) {
      const out = copyFilled({ entity: v.entity || "" }, v, ["name", "attribute", "unit", "template"]);
      if (v.display === "bar" || v.display === "graph") {
        out.display = v.display;
        if (v.max_source === "entity") {
          if (v.max_entity) {
            out.max_entity = v.max_entity;
            if (v.max_attribute) out.max_attribute = v.max_attribute;
          }
        } else if (isFilled(v.max) && Number.isFinite(Number(v.max))) {
          out.max = Number(v.max);
        }
      }
      return out;
    },
  },
};

class PcControlCardEditor extends HTMLElementBase {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    // null = main view · { kind, i } = sub-editor of row i of a list
    // (kind: storages | custom | drives).
    this._view = null;
    this._yaml = false; // sub-editor shows the code view
    this._maxMode = null; // custom sub-editor: "value" | "entity" while picking the maximum (null = derive from the row)
    this._adding = new Set(); // lists currently showing their "add" picker
    this._mounted = null; // key of the view whose skeleton is in the shadow DOM
  }

  setConfig(config) {
    this._config = config || {};
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    // `hass` is re-set on every state change in HA. Re-assigning each
    // form's data every time would be wasteful (and fight with typing),
    // so once mounted only the forms' own `hass` is refreshed.
    if (!this._mounted) {
      this._render();
      return;
    }
    this._forms().forEach((f) => (f.hass = hass));
  }

  _forms() {
    return [...this.shadowRoot.querySelectorAll("ha-form, ha-yaml-editor")];
  }

  // Flatten metrics.<metric> → _metric_* so the main form has one field per
  // row. Storage, custom metrics and drives are NOT part of the form: they
  // are owned by the list UI below it.
  _flatten(config) {
    const migrated = config || {};
    const m = migrated.metrics || {};
    const flat = { ...migrated };
    delete flat.metrics;
    delete flat.drives;
    for (const k of METRIC_KEYS) {
      const item = m[k] || {};
      flat[`_metric_${k}`] = item.entity;
      flat[`_display_${k}`] = item.display === "graph" ? "graph" : "bar";
      if (k === "ram_usage") flat._metric_ram_usage_total = item.total;
    }
    return flat;
  }

  // Convert form data back to the canonical config shape.
  _unflatten(value) {
    const next = { ...value };
    const metrics = {};
    for (const k of METRIC_KEYS) {
      const v = next[`_metric_${k}`];
      if (v) {
        metrics[k] = { entity: v };
        if (next[`_display_${k}`] === "graph") metrics[k].display = "graph";
      }
      delete next[`_metric_${k}`];
      delete next[`_display_${k}`];
    }
    if (next._metric_ram_usage_total && metrics.ram_usage) metrics.ram_usage.total = next._metric_ram_usage_total;
    delete next._metric_ram_usage_total;
    if (next.graph_hours === "" || next.graph_hours == null) delete next.graph_hours;

    // Lists owned by the list UI — carried over from the current config so
    // the main form can never drop or alter them.
    const cur = this._config?.metrics || {};
    if (Array.isArray(cur.storages)) {
      if (cur.storages.length) metrics.storages = cur.storages;
    } else {
      for (const k of LEGACY_STORAGE_KEYS) if (isFilled(cur[k])) metrics[k] = cur[k];
    }
    if (Array.isArray(cur.custom) && cur.custom.length) metrics.custom = cur.custom;
    if (Object.keys(metrics).length) next.metrics = metrics;
    else delete next.metrics;

    const drives = this._config?.drives;
    if (Array.isArray(drives) && drives.length) {
      next.drives = drives.map(({ status, temp, name }) => ({ status, temp, name }));
    } else delete next.drives;
    return next;
  }

  // ── Config plumbing ────────────────────────────────────────────

  _fireConfig(next) {
    this._config = next;
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: next },
        bubbles: true,
        composed: true,
      }),
    );
  }

  // The rows of a list.
  _listGet(kind) {
    const c = this._config || {};
    const m = c.metrics || {};
    if (kind === "custom") return Array.isArray(m.custom) ? m.custom : [];
    if (kind === "storages") return Array.isArray(m.storages) ? m.storages : legacyStorages(m);
    if (kind === "drives") return Array.isArray(c.drives) ? c.drives : [];
    return [];
  }

  // Commit a new list: update the config, tell HA, refresh.
  _setList(kind, list) {
    const next = { ...this._config };
    if (kind === "drives") {
      const drives = list.map(({ status, temp, name }) => ({ status, temp, name }));
      if (drives.length) next.drives = drives;
      else delete next.drives;
    } else {
      const metrics = { ...(next.metrics || {}) };
      if (kind === "storages") for (const k of LEGACY_STORAGE_KEYS) delete metrics[k];
      if (list.length) metrics[kind] = list;
      else delete metrics[kind];
      if (Object.keys(metrics).length) next.metrics = metrics;
      else delete next.metrics;
    }
    this._fireConfig(next);
    this._render();
  }

  _viewKey() {
    const v = this._view;
    return v ? `${v.kind}:${v.i}${v.j != null ? `:${v.j}` : ""}` : "main";
  }

  // The config row the sub-editor is currently editing (or null).
  _viewItem() {
    const v = this._view;
    if (!v) return null;
    return this._listGet(v.kind)[v.i] || null;
  }

  _openRow(kind, i) {
    this._view = { kind, i };
    this._yaml = false;
    this._maxMode = null;
    this._render();
  }

  _back() {
    this._view = null;
    this._yaml = false;
    this._maxMode = null;
    this._render();
  }

  // ── Rendering ──────────────────────────────────────────────────

  _render() {
    if (!this._hass || !this._config) return;
    // The row being edited may vanish (config replaced from the code editor).
    if (this._view && !this._viewItem()) {
      this._view = null;
      this._yaml = false;
      this._maxMode = null;
    }
    const want = this._viewKey();
    if (this._mounted !== want) this._mount(want);
    if (this._view) this._refreshSub();
    else this._refreshMain();
  }

  // Heading + hint + row list + "add" box of one list.
  _buildSection(kind) {
    const def = LIST_DEFS[kind];
    const sec = document.createElement("div");
    sec.className = "cm-section";
    sec.dataset.kind = kind;
    sec.innerHTML = `
      <h3 class="cm-title">${def.title}</h3>
      <div class="cm-hint">${def.hint}</div>
      <div class="cm-list"></div>
      <div class="cm-add"></div>
    `;
    return sec;
  }

  // Build the static skeleton of a view (main view or a row sub-editor).
  _mount(want) {
    const root = this.shadowRoot;
    root.innerHTML = `<style>${EDITOR_STYLES}</style>`;
    this._mounted = want;
    this._adding.clear();

    if (!this._view) {
      const wrap = document.createElement("div");
      wrap.className = "wrap";

      const form = document.createElement("ha-form");
      form.className = "main-form";
      form.schema = EDITOR_SCHEMA;
      form.computeLabel = (s) => EDITOR_LABELS[s.name] || s.name;
      form.addEventListener("value-changed", (e) => {
        this._fireConfig(this._unflatten(e.detail.value));
      });
      wrap.appendChild(form);

      for (const kind of MAIN_LISTS) wrap.appendChild(this._buildSection(kind));
      root.appendChild(wrap);
      return;
    }

    // Sub-editor skeleton
    const kind = this._view.kind;
    const sub = document.createElement("div");
    sub.className = "wrap sub";
    sub.innerHTML = `
      <div class="sub-head"><div class="sub-title">${SUB_DEFS[kind].title}</div></div>
      <div class="sub-body"></div>
    `;
    const head = sub.querySelector(".sub-head");
    const back = haIconButton("back", "Back", "back");
    const code = haIconButton("code", "Show code editor", "code");
    back.addEventListener("click", () => this._back());
    code.addEventListener("click", () => {
      this._yaml = !this._yaml;
      this._render();
    });
    head.prepend(back);
    head.append(code);
    root.appendChild(sub);
  }

  // ── Main view ──────────────────────────────────────────────────

  _refreshMain() {
    const form = this.shadowRoot.querySelector(".main-form");
    if (form) {
      form.hass = this._hass;
      form.data = this._flatten(this._config);
    }
    this._refreshSections();
  }

  _refreshSections() {
    this.shadowRoot.querySelectorAll(".cm-section").forEach((sec) => {
      this._syncRows(sec);
      this._syncAdd(sec);
    });
  }

  // Keep a section's row list in step with its config list. Rows are rebuilt
  // only when the count changes; otherwise each row's picker is updated in
  // place (also what makes a drag-reorder just a data swap).
  _syncRows(sec) {
    const kind = sec.dataset.kind;
    const def = LIST_DEFS[kind];
    const cont = sec.querySelector(".cm-list");
    if (!cont) return;
    const list = this._listGet(kind);
    if (cont.children.length !== list.length) {
      cont.innerHTML = "";
      list.forEach(() => cont.appendChild(this._buildRow(kind, cont)));
    }
    [...cont.children].forEach((row, i) => {
      const f = row.querySelector("ha-form");
      f.hass = this._hass;
      f.data = { [def.key]: list[i]?.[def.key] || "" };
    });
  }

  _buildRow(kind, cont) {
    const def = LIST_DEFS[kind];
    const row = document.createElement("div");
    row.className = "cm-row";
    const handle = document.createElement("div");
    handle.className = "handle";
    handle.title = "Drag to reorder";
    handle.innerHTML = eIcon("drag");
    const form = document.createElement("ha-form");
    form.className = "row-form";
    const rm = haIconButton("close", "Remove", "rm");
    const ed = haIconButton("pencil", "Edit", "ed");
    row.append(handle, form, rm, ed);

    // Rows are positional: DOM order always mirrors the config order.
    const idx = () => [...cont.children].indexOf(row);

    form.schema = def.rowSchema;
    form.computeLabel = () => ""; // like the official rows: no label, just the picker
    form.addEventListener("value-changed", (e) => {
      e.stopPropagation();
      const ent = e.detail?.value?.[def.key];
      const list = [...this._listGet(kind)];
      const i = idx();
      if (!ent || i < 0 || !list[i] || list[i][def.key] === ent) return;
      list[i] = { ...list[i], [def.key]: ent };
      this._setList(kind, list);
    });

    rm.addEventListener("click", () => {
      const list = [...this._listGet(kind)];
      const i = idx();
      if (i < 0) return;
      list.splice(i, 1);
      this._setList(kind, list);
    });
    ed.addEventListener("click", () => {
      const i = idx();
      if (i < 0) return;
      this._openRow(kind, i);
    });
    this._bindDrag(handle, row, cont, kind);
    return row;
  }

  // Drag-to-reorder on the handle. The dragged row follows the pointer;
  // the others slide out of the way. On release the new order is committed.
  _bindDrag(handle, row, cont, kind) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const rows = [...cont.children];
      const from = rows.indexOf(row);
      if (rows.length < 2 || from < 0) return;
      e.preventDefault();

      const rects = rows.map((r) => r.getBoundingClientRect());
      const gap = rects[1].top - rects[0].bottom;
      const step = rects[from].height + gap;
      const startY = e.clientY;
      let to = from;

      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events / unsupported — listeners on the handle still fire */
      }
      row.classList.add("dragging");
      rows.forEach((r) => r !== row && r.classList.add("shifting"));

      const onMove = (ev) => {
        const dy = ev.clientY - startY;
        row.style.transform = `translateY(${dy}px)`;
        // Target slot = the row whose original centre is closest.
        const centre = rects[from].top + rects[from].height / 2 + dy;
        let best = Infinity;
        rects.forEach((r, i) => {
          const d = Math.abs(centre - (r.top + r.height / 2));
          if (d < best) {
            best = d;
            to = i;
          }
        });
        rows.forEach((r, i) => {
          if (i === from) return;
          let shift = 0;
          if (from < to && i > from && i <= to) shift = -step;
          else if (from > to && i < from && i >= to) shift = step;
          r.style.transform = shift ? `translateY(${shift}px)` : "";
        });
      };

      const finish = (commit) => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onCancel);
        try {
          handle.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
        rows.forEach((r) => {
          r.style.transform = "";
          r.classList.remove("dragging", "shifting");
        });
        if (commit && to !== from) {
          const list = [...this._listGet(kind)];
          list.splice(to, 0, list.splice(from, 1)[0]);
          this._setList(kind, list);
        }
      };
      const onUp = () => finish(true);
      const onCancel = () => finish(false);

      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onCancel);
    });
  }

  // "Add …" — HA's tonal small button (same as the Entities card), which
  // swaps for a one-shot entity picker. Picking an entity appends a row and
  // puts the button back.
  _makeAddButton(kind) {
    const label = LIST_DEFS[kind].addLabel;
    const onClick = () => {
      this._adding.add(kind);
      const sec = this.shadowRoot.querySelector(`.cm-section[data-kind="${kind}"]`);
      if (sec) this._syncAdd(sec);
    };
    if (customElements.get("ha-button")) {
      const b = document.createElement("ha-button");
      b.className = "add-btn";
      b.setAttribute("appearance", "filled");
      b.setAttribute("size", "small");
      const ic = document.createElement("ha-svg-icon");
      ic.slot = "start";
      ic.path = EDITOR_ICONS.add;
      b.append(ic, label);
      b.addEventListener("click", onClick);
      return b;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "add-btn";
    b.innerHTML = `${eIcon("add")}<span>${label}</span>`;
    b.addEventListener("click", onClick);
    return b;
  }

  _syncAdd(sec) {
    const kind = sec.dataset.kind;
    const def = LIST_DEFS[kind];
    const box = sec.querySelector(".cm-add");
    if (!box) return;
    const mode = this._adding.has(kind) ? "picker" : "button";
    if (box.dataset.mode === mode) {
      const f = box.querySelector("ha-form");
      if (f) f.hass = this._hass;
      return;
    }
    box.dataset.mode = mode;
    box.innerHTML = "";

    if (mode === "button") {
      box.appendChild(this._makeAddButton(kind));
      return;
    }

    const f = document.createElement("ha-form");
    f.hass = this._hass;
    f.schema = def.rowSchema;
    f.data = { [def.key]: "" };
    f.computeLabel = () => def.pickerLabel;
    f.addEventListener("value-changed", (e) => {
      e.stopPropagation();
      const ent = e.detail?.value?.[def.key];
      if (!ent) return;
      this._adding.delete(kind);
      this._setList(kind, [...this._listGet(kind), { [def.key]: ent }]);
    });
    const cancel = haIconButton("close", "Cancel", "cancel");
    cancel.addEventListener("click", () => {
      this._adding.delete(kind);
      this._syncAdd(sec);
    });
    box.append(f, cancel);
  }

  // ── Sub-editor ─────────────────────────────────────────────────

  _refreshSub() {
    const root = this.shadowRoot;
    const kind = this._view.kind;
    const def = SUB_DEFS[kind];
    const item = this._viewItem() || {};
    // Like the official sub-editor, the toggle swaps its glyph: `{}` while the
    // visual form is shown, a form icon while the code view is shown.
    const codeBtn = root.querySelector(".code");
    codeBtn.path = this._yaml ? EDITOR_ICONS.list : EDITOR_ICONS.code;
    codeBtn.label = this._yaml ? "Show visual editor" : "Show code editor";

    const body = root.querySelector(".sub-body");
    const mode = this._yaml ? "yaml" : "gui";
    if (body.dataset.mode !== mode) {
      body.dataset.mode = mode;
      body.innerHTML = "";
      body.appendChild(mode === "yaml" ? this._buildYaml(item) : this._buildSubForm());
    }

    if (mode === "gui") {
      const f = body.querySelector("ha-form");
      f.hass = this._hass;
      const ui = { maxMode: this._maxMode ?? (item.max_entity ? "entity" : "value") };
      const schemaKey = def.schemaKey(item, ui);
      if (f._schemaKey !== schemaKey) {
        f._schemaKey = schemaKey;
        f.schema = def.schema(item, ui);
      }
      f.data = def.toForm(item, ui);
    } else {
      // The code view keeps its own text while typing; only hass is refreshed.
      const y = body.firstElementChild;
      if (y && "hass" in y) y.hass = this._hass;
    }
  }

  _buildSubForm() {
    const def = SUB_DEFS[this._view.kind];
    const f = document.createElement("ha-form");
    f.computeLabel = (s) => def.labels[s.name] || s.name;
    f.computeHelper = (s) => def.helpers[s.name];
    f.addEventListener("value-changed", (e) => {
      e.stopPropagation();
      this._maxMode = e.detail.value?.max_source || null;
      this._applyRow(this._formToRow(e.detail.value), true);
    });
    return f;
  }

  // Code view: HA's YAML editor when it's loaded, else a JSON textarea.
  _buildYaml(item) {
    if (customElements.get("ha-yaml-editor")) {
      const y = document.createElement("ha-yaml-editor");
      y.hass = this._hass;
      y.defaultValue = item;
      y.addEventListener("value-changed", (e) => {
        e.stopPropagation();
        const v = e.detail?.value;
        if (e.detail?.isValid === false || !v || typeof v !== "object" || Array.isArray(v)) return;
        this._applyRow(v);
      });
      return y;
    }
    const ta = document.createElement("textarea");
    ta.className = "json";
    ta.spellcheck = false;
    ta.value = JSON.stringify(item, null, 2);
    ta.addEventListener("input", () => {
      try {
        const v = JSON.parse(ta.value);
        if (v && typeof v === "object" && !Array.isArray(v)) {
          ta.classList.remove("invalid");
          this._applyRow(v);
          return;
        }
      } catch {
        /* fall through */
      }
      ta.classList.add("invalid");
    });
    return ta;
  }

  // Form values → a clean row. Any key the form doesn't manage is preserved.
  _formToRow(v) {
    const def = SUB_DEFS[this._view.kind];
    const out = def.fromForm(v);
    const prev = this._viewItem() || {};
    for (const k of Object.keys(prev)) {
      if (!def.keys.includes(k)) out[k] = prev[k];
    }
    return out;
  }

  // `fromForm` rows come from the visual form, which tracks the maximum's
  // source itself; code-view edits re-derive it from the row.
  _applyRow(row, fromForm = false) {
    const v = this._view;
    if (!v) return;
    if (!fromForm) this._maxMode = null;
    const list = [...this._listGet(v.kind)];
    list[v.i] = row;
    this._setList(v.kind, list);
  }
}

// ── Register ────────────────────────────────────────────────────────
// Guarded so importing this module under Node (for tests) is a no-op —
// these globals only exist in the browser.

if (typeof customElements !== "undefined") {
  if (!customElements.get("pc-control-card-editor")) {
    customElements.define("pc-control-card-editor", PcControlCardEditor);
  }
  if (!customElements.get("pc-control-card")) {
    customElements.define("pc-control-card", PcControlCard);
  }
}

if (typeof window !== "undefined") {
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "pc-control-card",
    name: "PC Control Card",
    description:
      "Tile, chip, or full feature card for controlling a PC (turn on / sleep / shutdown) with live CPU/RAM/GPU metrics and custom rows.",
    preview: false,
  });

  /* eslint-disable no-console */
  console.info(
    `%c PC-CONTROL-CARD %c v${CARD_VERSION} `,
    "color: white; background: #3a7bd5; font-weight: 700; border-radius: 3px 0 0 3px; padding: 1px 4px;",
    "color: #3a7bd5; background: #f1f5f9; border-radius: 0 3px 3px 0; padding: 1px 4px;",
  );
}
