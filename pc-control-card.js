/**
 * PC Control Card · custom Lovelace card for Home Assistant
 *
 * A drop-in custom card with three variants:
 *   - `tile`    — compact toggle tile with 3 action buttons
 *   - `chip`    — Mushroom-style: icon chip + inline uptime + mini metrics
 *                 (CPU/GPU usage + temps, RAM, one row per disk)
 *   - `feature` — full card with metric bars (CPU/GPU usage + temps, RAM,
 *                 one bar per disk) + uptime + 3 actions
 *
 * Install:
 *   1. Save this file to `/config/www/pc-control-card.js`
 *   2. Settings → Dashboards → ⋮ → Resources → Add Resource
 *        URL: /local/pc-control-card.js
 *        Type: JavaScript Module
 *   3. Add the card via YAML (see README.md)
 *
 * Theme: follows HA's --card-background-color, --primary-text-color,
 *        --secondary-text-color, --divider-color, --primary-color,
 *        --error-color. Light & dark themes Just Work.
 */

const CARD_VERSION = '1.3.0';

// ── State machine ───────────────────────────────────────────────────
//   off / on are derived from the binary_sensor.
//   booting / shutting / sleeping are local "pending" overlays that
//   resolve when the sensor flips, or expire after a timeout.

const PENDING_TIMEOUT_MS = 90_000;
const RESTART_TIMEOUT_MS = 300_000; // NAS reboots are slower than a PC boot
const SLEEP_DISPLAY_MS   = 6_000;
const ARM_TIMEOUT_MS     = 2_400;

const META = {
  off:      { label: 'Off',           tone: 'idle',  pulse: false },
  on:       { label: 'On',            tone: 'live',  pulse: false },
  sleeping: { label: 'Sleeping',      tone: 'warm',  pulse: false },
  booting:  { label: 'Booting',       tone: 'warm',  pulse: true  },
  shutting:   { label: 'Shutting down', tone: 'alert', pulse: true  },
  restarting: { label: 'Restarting',    tone: 'warm',  pulse: true  },
  waking:   { label: 'Waking',        tone: 'warm',  pulse: true  },
};

// ── Metric registry ─────────────────────────────────────────────────
// Single source of truth for the non-storage metric rows. Order here
// is the order they render in the chip mini-stats and the feature
// metric bars: usage and temperature pairs grouped per component.
const METRIC_KEYS = ['cpu_usage', 'cpu_temp', 'gpu_usage', 'gpu_temp', 'ram_usage'];
const METRIC_LABELS = {
  cpu_usage: 'CPU',
  cpu_temp:  'CPU TEMP',
  gpu_usage: 'GPU',
  gpu_temp:  'GPU TEMP',
  ram_usage: 'RAM',
};

// ── Config migration ────────────────────────────────────────────────
// Pre-1.1 used cpu/ram/gpu (and ram_total) for both visibility flags
// and metric entity ids. 1.1+ namespaces these by purpose so a single
// component can carry both a usage% sensor and a °C sensor. This
// helper runs on every setConfig AND on the editor's flatten() path
// so old configs surface correctly in the visual editor too.
function migrateConfig(raw) {
  const out = { ...raw };
  // Visibility flags — only copy if the new key isn't already set.
  if (out.show_cpu !== undefined && out.show_cpu_usage === undefined) out.show_cpu_usage = out.show_cpu;
  if (out.show_ram !== undefined && out.show_ram_usage === undefined) out.show_ram_usage = out.show_ram;
  if (out.show_gpu !== undefined && out.show_gpu_usage === undefined) out.show_gpu_usage = out.show_gpu;
  delete out.show_cpu; delete out.show_ram; delete out.show_gpu;

  if (out.metrics) {
    const m = { ...out.metrics };
    if (m.cpu       && !m.cpu_usage)       m.cpu_usage       = m.cpu;
    if (m.ram       && !m.ram_usage)       m.ram_usage       = m.ram;
    if (m.gpu       && !m.gpu_usage)       m.gpu_usage       = m.gpu;
    if (m.ram_total && !m.ram_usage_total) m.ram_usage_total = m.ram_total;
    delete m.cpu; delete m.ram; delete m.gpu; delete m.ram_total;
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
  if (typeof raw === 'string') {
    const [domain] = raw.split('.');
    const service =
      domain === 'switch' ? 'turn_on' :
      domain === 'button' ? 'press' :
      domain === 'script' ? 'turn_on' :
      domain === 'input_button' ? 'press' :
      domain === 'automation' ? 'trigger' :
      null;
    if (!service) return null;
    return { entity: raw, domain, service };
  }
  if (raw.entity && raw.service) {
    const [domain, service] = raw.service.split('.');
    if (!domain || !service) return null;
    return { entity: raw.entity, domain, service };
  }
  return null;
}

function fmtUptime(ms) {
  if (ms < 0 || !Number.isFinite(ms)) return '—';
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
  if (ent.attributes?.device_class === 'timestamp' || !Number.isFinite(num)) {
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? now - t : null;
  }
  const unit = (ent.attributes?.unit_of_measurement || '').toLowerCase();
  const mult =
    /^(d|day|days)$/.test(unit)            ? 86_400_000 :
    /^(h|hr|hrs|hour|hours)$/.test(unit)   ? 3_600_000  :
    /^(min|m|minute|minutes)$/.test(unit)  ? 60_000     :
    1000;
  return num * mult;
}

// Format a number for the value label. Single decimal under 10, no
// decimals at 10+, three significant figures otherwise.
function fmtNum(n) {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 10)  return n.toFixed(1);
  return n.toFixed(2);
}

// Default set of drive/volume status states treated as healthy. Synology
// reports "normal" for healthy disks and volumes. Overridable per card via
// the `healthy_states` config key.
export const DEFAULT_HEALTHY = ['normal', 'ok', 'healthy', 'good'];

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
const DATA_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
function scaleDataSize(value, total, unit) {
  const base = DATA_UNITS.indexOf(unit);
  if (base < 0) return { value, total, unit };
  const ref = (Number.isFinite(total) && total > 0) ? total : value;
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
  const { attribute = null, totalAttribute = null, totalConfigured = false, autoDetect = false, unit: unitOverride = null } = opts;

  let value;
  let unit = unitOverride || (ent.attributes?.unit_of_measurement ?? '');
  if (attribute) {
    value = parseFloat(ent.attributes?.[attribute]);
  } else {
    value = parseFloat(ent.state);
    if (!Number.isFinite(value) && autoDetect) {
      const auto = parseFloat(ent.attributes?.UsedSpacePercentage);
      if (Number.isFinite(auto)) { value = auto; unit = ''; } // percentage — no unit suffix
    }
  }
  if (!Number.isFinite(value)) return null;

  let total = null;
  if (totalAttribute) total = parseFloat(ent.attributes?.[totalAttribute]);
  else if (totalEnt)  total = parseFloat(totalEnt.state);

  // An explicit source unit auto-scales value + total to a readable magnitude.
  if (unitOverride) ({ value, total, unit } = scaleDataSize(value, total, unit));

  const space = unit ? ' ' : '';
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

  const pct = `${Math.round(value)}${unit || '%'}`;
  return { displayValue: pct, compactValue: pct, barPct: Math.max(0, Math.min(100, value)) };
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
  flex-shrink: 0;
  transition: background 220ms, color 220ms;
  position: relative;
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
  display: flex; gap: 14px; padding: 18px; align-items: center;
}
.chip .icon-box.chip-icon {
  width: 52px; height: 52px; border-radius: 14px;
  background: color-mix(in oklab, var(--spc-fg) 8%, var(--spc-bg));
  color: var(--spc-fg-2);
}
.chip.is-on        .icon-box.chip-icon { background: var(--spc-accent); color: #fff; }
.chip.is-sleeping  .icon-box.chip-icon { background: var(--spc-warn);   color: #fff; }
.chip .head .meta { flex: 1; min-width: 0; }
.chip .name { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
.chip .status {
  display: flex; align-items: center; gap: 6px; margin-top: 3px;
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
.feature .status { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: 13px; font-weight: 500; }
.feature .status .label { color: var(--spc-fg-2); }
.feature .status.live  .label { color: var(--spc-accent); }
.feature .status.warm  .label { color: var(--spc-warn); }
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
/* Drive groups: a drive header + its nested volume bars. A thin inset
   separator divides consecutive groups — it sits within the metrics'
   side padding so it's narrower than the full-width action-footer
   divider and the two read as different things. */
.feature .drive-group { display: flex; flex-direction: column; gap: 8px; }
.feature .metrics.has-drive-volumes .drive-group + .drive-group {
  border-top: 1px solid var(--spc-border);
  margin-top: 4px;
  padding-top: 14px;
}
.feature .drive-group .metric.nested { padding-left: 16px; }
.chip .mini-stat .mval.bad { color: var(--spc-alert); }
`;

// ── Icons (inline SVG strings) ──────────────────────────────────────

const ICONS = {
  power: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v8"/><path d="M5.6 7.6a8 8 0 1 0 12.8 0"/></svg>',
  moon:  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
  restart: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v5h-5"/></svg>',
  pc:    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/></svg>',
  nas:   '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="7" rx="1.5"/><rect x="4" y="14" width="16" height="7" rx="1.5"/><path d="M8 6.5h.01"/><path d="M8 17.5h.01"/></svg>',
  spinner: '<svg class="spinner" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" stroke-opacity="0.18"/><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
};

// ── The card ────────────────────────────────────────────────────────

// In a browser this resolves to the real HTMLElement. Under Node (where
// the module is imported for unit tests) there's no DOM, so fall back to a
// bare base class — the custom-element machinery is never exercised there.
const HTMLElementBase = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

export class PcControlCard extends HTMLElementBase {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._pending = null;     // 'on' | 'sleep' | 'restart' | 'shutdown'
    this._pendingSince = 0;
    this._armed = { sleep: false, shutdown: false, restart: false };
    this._restartDipped = false;
    this._armTimers = {};
    this._sleepTimer = null;
    this._tickTimer = null;
  }

  setConfig(config) {
    if (!config) throw new Error('pc-control-card: config required');
    if (!config.status_entity) {
      throw new Error('pc-control-card: `status_entity` is required (e.g. binary_sensor.pc_status — binary_sensor, sensor, or switch all work)');
    }
    const migrated = migrateConfig(config);
    this._config = {
      variant: 'tile',
      name: 'My PC',
      status_entity: 'binary_sensor.pc_status',
      uptime_entity: null,
      turn_on: null,
      sleep: null,
      restart: null,
      shutdown: null,
      confirm_shutdown: true,
      confirm_sleep: false,
      confirm_restart: true,
      show_turn_on: true,
      show_sleep: true,
      show_restart: false,
      show_shutdown: true,
      show_cpu_usage: true,
      show_cpu_temp:  false,
      show_gpu_usage: true,
      show_gpu_temp:  false,
      show_ram_usage: true,
      show_storage:   true,
      show_drives:    true,
      accent_color: null,
      healthy_states: null,
      icon: 'pc',
      metrics: {},
      ...migrated,
    };
    this._storages = this._normalizeStorages();
    this._drives = this._normalizeDrives();
    this._healthyStates = (Array.isArray(this._config.healthy_states) && this._config.healthy_states.length
      ? this._config.healthy_states
      : DEFAULT_HEALTHY).map((s) => String(s).toLowerCase());
    this._actions = {
      turn_on:  parseAction(this._config.turn_on),
      sleep:    parseAction(this._config.sleep),
      restart:  parseAction(this._config.restart),
      shutdown: parseAction(this._config.shutdown),
    };
    this._build();
    this._update();
  }

  set hass(hass) {
    this._hass = hass;
    // Clear pending overlay when the sensor confirms the action.
    if (this._pending && hass) {
      const s = hass.states[this._config.status_entity]?.state;
      const elapsed = Date.now() - this._pendingSince;
      if (this._pending === 'on'       && s === 'on'  ) this._clearPending();
      if (this._pending === 'shutdown' && s === 'off' ) this._clearPending();
      if (this._pending === 'restart') {
        // Reboot takes the box down (off/unavailable) then back to on.
        if (s !== 'on') this._restartDipped = true;
        if (this._restartDipped && s === 'on') this._clearPending();
        if (elapsed > RESTART_TIMEOUT_MS) this._clearPending();
      } else if (elapsed > PENDING_TIMEOUT_MS) {
        this._clearPending();
      }
    }
    this._update();
  }

  getCardSize() {
    const v = this._variant();
    if (v === 'feature') return 4;
    if (v === 'chip')    return 2;
    return 1; // tile is roughly half the height of chip
  }

  static getConfigElement() {
    // Returns the visual editor element HA shows in the dashboard UI.
    // Lives in PcControlCardEditor below.
    return document.createElement('pc-control-card-editor');
  }

  static getStubConfig() {
    return {
      variant: 'tile',
      name: 'My PC',
      status_entity: 'binary_sensor.pc_status',
      turn_on: 'switch.my_pc',
      sleep: 'button.my_pc_sleep',
      shutdown: 'button.my_pc_shutdown',
      confirm_shutdown: true,
      confirm_sleep: false,
      show_turn_on: true,
      show_sleep: true,
      show_shutdown: true,
      metrics: {
        cpu_usage: 'sensor.my_pc_cpu_percent',
        // cpu_temp: 'sensor.my_pc_cpu_temp',     // °C — default off
        ram_usage: 'sensor.my_pc_ram_percent',
        gpu_usage: 'sensor.my_pc_gpu_load',
        // gpu_temp: 'sensor.my_pc_gpu_temp',     // °C — default off
        storages: [
          { entity: 'sensor.my_pc_storage_percent', name: 'Disk' },
        ],
      },
    };
  }

  disconnectedCallback() {
    Object.values(this._armTimers).forEach(clearTimeout);
    clearTimeout(this._sleepTimer);
    clearInterval(this._tickTimer);
  }

  // ── Derived status ────────────────────────────────────────────
  _derivedStatus() {
    const s = this._hass?.states[this._config.status_entity]?.state;
    if (this._pending === 'on')       return 'booting';
    if (this._pending === 'shutdown') return 'shutting';
    if (this._pending === 'restart')  return 'restarting';
    if (this._pending === 'sleep')    return 'sleeping';
    if (s === 'on')  return 'on';
    return 'off';
  }

  _uptime() {
    const ent = this._hass?.states[this._config.status_entity];
    if (!ent || ent.state !== 'on') return null;
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
      return m.storages.filter((s) => s && s.entity).map((s, i) => normalizeStorageItem(s, i, 'Disk'));
    }
    if (m.storage) {
      return [normalizeStorageItem({
        entity: m.storage,
        attribute: m.storage_attribute,
        total: m.storage_total,
        total_attribute: m.storage_total_attribute,
        unit: m.storage_unit,
        name: m.storage_name,
      }, 0, 'Disk')];
    }
    return [];
  }

  // Normalize the optional top-level `drives` array into clean
  // { status, temp, name, volumes } records — one per physical disk. A
  // drive may carry nested `volumes` (same shape as metrics.storages);
  // when present they render grouped under the drive in the feature card.
  // Entries without a `status` sensor are dropped.
  _normalizeDrives() {
    const d = this._config.drives;
    if (!Array.isArray(d)) return [];
    return d
      .filter((x) => x && x.status)
      .map((x, i) => ({
        status: x.status,
        temp: x.temp || null,
        name: x.name || (i === 0 ? 'Drive' : `Drive ${i + 1}`),
        volumes: Array.isArray(x.volumes)
          ? x.volumes.filter((v) => v && v.entity).map((v, j) => normalizeStorageItem(v, j, 'Volume'))
          : [],
      }));
  }

  // Display string for a drive row: temperature ("38 °C") when a temp
  // sensor is configured and numeric, otherwise the capitalized status.
  _driveValue(d) {
    if (d.temp) {
      const te = this._hass?.states[d.temp];
      const n = parseFloat(te?.state);
      if (Number.isFinite(n)) {
        const unit = te.attributes?.unit_of_measurement || '°C';
        return `${Math.round(n)} ${unit}`;
      }
    }
    const st = this._hass?.states[d.status]?.state;
    if (st) return st.charAt(0).toUpperCase() + st.slice(1);
    return '—';
  }

  // Resolve a metric entity (+ optional separate total entity) from hass
  // and delegate the parsing/formatting to computeMetricDisplay. Storage
  // entries are keyed by index: 'storage_0', 'storage_1', … and may pull
  // their value from an attribute; for HASS.Agent (non-numeric state) the
  // value auto-detects from the UsedSpacePercentage attribute.
  _metricValue(key) {
    const m = this._config.metrics || {};
    let entityId, totalId, attribute = null, totalAttribute = null, autoDetect = false, unit = null;

    if (key === 'storage' || key.startsWith('storage_')) {
      const idx = key === 'storage' ? 0 : parseInt(key.slice(8), 10);
      const s = this._storages?.[idx];
      if (!s) return null;
      entityId       = s.entity;
      totalId        = s.total;
      attribute      = s.attribute;
      totalAttribute = s.totalAttribute;
      unit           = s.unit;
      autoDetect     = !s.attribute; // only fall back when no explicit attribute
    } else if (key.startsWith('dvol_')) {
      // dvol_<driveIdx>_<volumeIdx> — a volume nested under a drive.
      const [, di, vi] = key.split('_');
      const v = this._drives?.[+di]?.volumes?.[+vi];
      if (!v) return null;
      entityId       = v.entity;
      totalId        = v.total;
      attribute      = v.attribute;
      totalAttribute = v.totalAttribute;
      unit           = v.unit;
      autoDetect     = !v.attribute;
    } else if (key === 'ram_usage') {
      entityId = m.ram_usage;
      totalId  = m.ram_usage_total;
    } else {
      entityId = m[key];
      totalId  = null;
    }

    if (!entityId) return null;
    const ent = this._hass?.states[entityId];
    if (!ent) return null;
    const totalEnt = totalId ? this._hass?.states[totalId] : null;

    return computeMetricDisplay(ent, totalEnt, {
      attribute,
      totalAttribute,
      totalConfigured: !!totalAttribute || !!totalId,
      autoDetect,
      unit,
    });
  }

  // ── Action handlers ──────────────────────────────────────────
  _callAction(name) {
    const a = this._actions[name];
    if (!a || !this._hass) return;
    this._hass.callService(a.domain, a.service, { entity_id: a.entity });
  }

  _setPending(p) {
    this._pending = p;
    this._pendingSince = Date.now();
    this._update();
  }
  _clearPending() {
    this._pending = null;
    clearTimeout(this._sleepTimer);
  }

  _onTurnOn() {
    if (this._derivedStatus() === 'on' || this._pending) return;
    // Bail before showing a pending overlay we'll never confirm.
    if (!this._actions.turn_on) return;
    this._setPending('on');
    this._callAction('turn_on');
  }
  _onSleep() {
    if (this._derivedStatus() !== 'on' || this._pending) return;
    if (!this._actions.sleep) return;
    if (this._config.confirm_sleep && !this._armed.sleep) {
      this._arm('sleep');
      return;
    }
    this._disarm('sleep');
    this._setPending('sleep');
    this._callAction('sleep');
    // No reliable "sleeping" state from the binary_sensor, so clear
    // the overlay after a short display window.
    this._sleepTimer = setTimeout(() => { this._clearPending(); this._update(); }, SLEEP_DISPLAY_MS);
  }
  _onShutdown() {
    if (this._derivedStatus() === 'off' || this._pending) return;
    if (!this._actions.shutdown) return;
    if (this._config.confirm_shutdown && !this._armed.shutdown) {
      this._arm('shutdown');
      return;
    }
    this._disarm('shutdown');
    this._setPending('shutdown');
    this._callAction('shutdown');
  }
  _onRestart() {
    if (this._derivedStatus() !== 'on' || this._pending) return;
    if (!this._actions.restart) return;
    if (this._config.confirm_restart && !this._armed.restart) {
      this._arm('restart');
      return;
    }
    this._disarm('restart');
    this._restartDipped = false;
    this._setPending('restart');
    this._callAction('restart');
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
    const html = TEMPLATES[variant](this._storages || [], this._drives || [], ICONS[this._config.icon] || ICONS.pc);
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
    } else if (typeof ac === 'string' && ac) {
      accentCss = ac;
    }
    if (accentCss) this.style.setProperty('--spc-accent', accentCss);
    else            this.style.removeProperty('--spc-accent');

    // Wire events once.
    const $ = (sel) => this.shadowRoot.querySelector(sel);
    if (variant === 'tile') {
      $('.circle').addEventListener('click', () => {
        const s = this._derivedStatus();
        if (s === 'off' || s === 'sleeping') this._onTurnOn();
        else if (s === 'on') this._onSleep();
      });
    }
    $('.btn-on').addEventListener('click', () => this._onTurnOn());
    $('.btn-sleep').addEventListener('click', () => this._onSleep());
    $('.btn-restart').addEventListener('click', () => this._onRestart());
    $('.btn-shutdown').addEventListener('click', () => this._onShutdown());

    // Tick uptime + animations.
    clearInterval(this._tickTimer);
    this._tickTimer = setInterval(() => this._update(), 1000);
  }

  _variant() {
    const v = this._config?.variant;
    if (v === 'feature' || v === 'chip') return v;
    return 'tile';
  }

  _update() {
    if (!this.shadowRoot.firstChild) return;
    const status = this._derivedStatus();
    const meta = META[status];
    const variant = this._variant();

    const root = this.shadowRoot.querySelector('.card');
    root.classList.toggle('is-on', status === 'on');
    root.classList.toggle('is-sleeping', status === 'sleeping');
    root.classList.toggle('is-off', status === 'off');

    // Track whether any action button is visible — used to collapse
    // the entire actions row + adjust the previous section's bottom
    // padding so the card has equal side/bottom gaps when buttons are
    // hidden (behaves like a pure status monitor).
    const vis = {
      on:       this._config.show_turn_on  !== false,
      sleep:    this._config.show_sleep    !== false,
      restart:  !!this._config.show_restart,
      shutdown: this._config.show_shutdown !== false,
    };
    const anyBtn = vis.on || vis.sleep || vis.restart || vis.shutdown;
    root.classList.toggle('no-actions', !anyBtn);

    // Name + status text
    root.querySelector('.name').textContent = this._config.name;
    const labelEl = root.querySelector('.status .label');
    labelEl.textContent = meta.label;
    const statusEl = root.querySelector('.status');
    statusEl.classList.toggle('live',  meta.tone === 'live');
    statusEl.classList.toggle('warm',  meta.tone === 'warm');
    statusEl.classList.toggle('alert', meta.tone === 'alert');
    statusEl.classList.toggle('idle',  meta.tone === 'idle');

    // Dot
    const dot = root.querySelector('.status .dot');
    dot.classList.remove('live','warm','alert','idle','pulse');
    dot.classList.add(meta.tone);
    if (meta.pulse) dot.classList.add('pulse');

    // Animated "…" for transitional states
    const anim = root.querySelector('.status .anim');
    anim.className = 'anim' + (meta.pulse ? ' dots' : '');

    // Pulsing ring around the icon during transitional states
    // (feature + chip have one; tile uses a different icon shape).
    const ring = root.querySelector('.icon-box .ring');
    if (ring) {
      if (meta.pulse) {
        ring.style.display = '';
        ring.className = 'ring ' + meta.tone;
      } else {
        ring.style.display = 'none';
      }
    }

    // Feature-only: uptime + metric bars
    if (variant === 'feature') {
      const up = this._uptime();
      const uval = root.querySelector('.uptime .uval');
      uval.textContent = up ?? '—';
      uval.classList.toggle('dim', !up);

      const isOn = status === 'on';
      const storageKeys = (this._storages || []).map((_, i) => `storage_${i}`);
      [...METRIC_KEYS, ...storageKeys].forEach((k) => {
        const row = root.querySelector(`.metric[data-key="${k}"]`);
        if (!row) return;
        // Hide the whole row when:
        //  - cpu_usage/cpu_temp/gpu_*/ram_usage: no entity OR show_<k> is false
        //  - storage_<i>: show_storage is false (entity always present
        //    because we filter in _normalizeStorages)
        let enabled;
        if (k.startsWith('storage_')) {
          enabled = this._config.show_storage !== false;
        } else {
          enabled = this._config[`show_${k}`] !== false && !!this._config.metrics?.[k];
        }
        row.style.display = enabled ? '' : 'none';
        if (!enabled) return;
        const m = this._metricValue(k);
        const valEl = row.querySelector('.mval');
        const fillEl = row.querySelector('.fill');
        if (isOn && m) {
          valEl.textContent = m.displayValue;
          fillEl.style.width = m.barPct != null ? `${m.barPct}%` : '0%';
        } else {
          valEl.textContent = '—';
          fillEl.style.width = '0%';
        }
      });

      // Per-drive groups: health header + (optional) nested volume bars.
      (this._drives || []).forEach((d, i) => {
        const row = root.querySelector(`.drive[data-key="drive_${i}"]`);
        if (!row) return;
        const enabled = this._config.show_drives !== false;
        const group = root.querySelector(`.drive-group[data-drive="${i}"]`);
        (group || row).style.display = enabled ? '' : 'none';
        if (!enabled) return;
        const dot = row.querySelector('.ddot');
        const valEl = row.querySelector('.dval');
        if (isOn) {
          const healthy = driveHealthy(this._hass?.states[d.status]?.state, this._healthyStates);
          dot.classList.toggle('ok', healthy);
          dot.classList.toggle('bad', !healthy);
          valEl.textContent = this._driveValue(d);
        } else {
          dot.classList.remove('ok', 'bad');
          valEl.textContent = '—';
        }
        // Nested volume usage bars (rendered like storage bars).
        (d.volumes || []).forEach((v, j) => {
          const vrow = root.querySelector(`.metric[data-key="dvol_${i}_${j}"]`);
          if (!vrow) return;
          const mv = isOn ? this._metricValue(`dvol_${i}_${j}`) : null;
          const valE = vrow.querySelector('.mval');
          const fillE = vrow.querySelector('.fill');
          if (isOn && mv) {
            valE.textContent = mv.displayValue;
            fillE.style.width = mv.barPct != null ? `${mv.barPct}%` : '0%';
          } else {
            valE.textContent = '—';
            fillE.style.width = '0%';
          }
        });
      });
    }

    // Chip-only: inline uptime + mini stats (cpu/ram/gpu + temps + first disk)
    if (variant === 'chip') {
      const up = this._uptime();
      const sep = root.querySelector('.uptime-sep');
      const upEl = root.querySelector('.uptime-inline');
      if (up && status === 'on') {
        sep.style.display = '';
        upEl.style.display = '';
        upEl.textContent = `up ${up}`;
      } else {
        sep.style.display = 'none';
        upEl.style.display = 'none';
      }

      const mini = root.querySelector('.mini-stats');
      const isOn = status === 'on';
      let anyMini = false;
      const chipStorageKeys = (this._storages || []).map((_, i) => `storage_${i}`);
      [...METRIC_KEYS, ...chipStorageKeys].forEach((k) => {
        const stat = mini.querySelector(`.mini-stat[data-key="${k}"]`);
        if (!stat) return;
        let enabled;
        if (k.startsWith('storage_')) {
          enabled = this._config.show_storage !== false;
        } else {
          enabled = this._config[`show_${k}`] !== false && !!this._config.metrics?.[k];
        }
        stat.style.display = enabled ? '' : 'none';
        if (!enabled) return;
        anyMini = true;
        const cell = stat.querySelector('.mval');
        const m = isOn ? this._metricValue(k) : null;
        // Chip uses the compact form (no "/ total" suffix) to fit the
        // narrower mini-stat column.
        cell.textContent = m ? m.compactValue : '—';
      });

      // Drives summary mini-stat (healthy/total), red if any unhealthy.
      if ((this._drives || []).length) {
        const stat = mini.querySelector('.mini-stat[data-key="drives_summary"]');
        if (stat) {
          const enabled = this._config.show_drives !== false;
          stat.style.display = enabled ? '' : 'none';
          if (enabled) {
            anyMini = true;
            const cell = stat.querySelector('.mval');
            if (isOn) {
              const total = this._drives.length;
              const healthy = this._drives.filter(
                (d) => driveHealthy(this._hass?.states[d.status]?.state, this._healthyStates),
              ).length;
              cell.textContent = `${healthy}/${total}`;
              cell.classList.toggle('bad', healthy < total);
            } else {
              cell.textContent = '—';
              cell.classList.remove('bad');
            }
          }
        }
      }
      mini.style.display = (isOn && anyMini) ? '' : 'none';
    }

    // Button states
    const onBtn = root.querySelector('.btn-on');
    const sleepBtn = root.querySelector('.btn-sleep');
    const restartBtn = root.querySelector('.btn-restart');
    const shutBtn = root.querySelector('.btn-shutdown');

    // Show/hide each action button per config. Remaining buttons fill
    // the row via flex: 1. The actions row + chip divider are hidden
    // by the .no-actions class on .card (set above), so no inline
    // style override is needed for them — only the individual buttons.
    onBtn.style.display      = vis.on       ? '' : 'none';
    sleepBtn.style.display   = vis.sleep    ? '' : 'none';
    restartBtn.style.display = vis.restart  ? '' : 'none';
    shutBtn.style.display    = vis.shutdown ? '' : 'none';

    const off  = status === 'off';
    const on   = status === 'on';
    const slp  = status === 'sleeping';
    const pend = this._pending != null;

    setBtn(onBtn, {
      disabled: on || pend,
      primary: off || slp,
      busy: this._pending === 'on',
      iconKey: 'power',
      label: variant === 'tile' ? 'On' : 'Turn on',
    });
    setBtn(sleepBtn, {
      disabled: !on || pend,
      primary: false,
      busy: this._pending === 'sleep',
      armed: this._armed.sleep,
      iconKey: 'moon',
      label: 'Sleep',
      armedLabel: this._config.confirm_sleep ? 'Confirm?' : null,
    });
    setBtn(restartBtn, {
      disabled: !on || pend,
      busy: this._pending === 'restart',
      armed: this._armed.restart,
      iconKey: 'restart',
      label: 'Restart',
      armedLabel: this._config.confirm_restart ? 'Confirm?' : null,
    });
    setBtn(shutBtn, {
      disabled: off || pend,
      primary: false,
      danger: true,
      armed: this._armed.shutdown,
      busy: this._pending === 'shutdown',
      iconKey: 'power',
      // Always "Shut down" — "Off" on the tile reads as a state toggle
      // and obscures the destructive intent. The .danger color + the
      // confirm flow are the safety signals.
      label: 'Shut down',
      armedLabel: this._config.confirm_shutdown ? 'Confirm?' : null,
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

  chip: (storages, drives, iconSvg) => `
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
          ${METRIC_KEYS.map((k) => `
          <div class="mini-stat" data-key="${k}">
            <div class="mlabel">${METRIC_LABELS[k]}</div>
            <div class="mval">—</div>
          </div>
          `).join('')}
          ${storages.map((s, i) => `
          <div class="mini-stat" data-key="storage_${i}">
            <div class="mlabel">${escapeHtml(s.name).toUpperCase()}</div>
            <div class="mval">—</div>
          </div>
          `).join('')}
          ${drives.length ? `
          <div class="mini-stat" data-key="drives_summary">
            <div class="mlabel">DRIVES</div>
            <div class="mval">—</div>
          </div>
          ` : ''}
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

  feature: (storages, drives, iconSvg) => `
    <ha-card class="card feature">
      <div class="head">
        <div class="icon-box lg">${iconSvg}<span class="ring" style="display:none"></span></div>
        <div class="meta">
          <div class="name"></div>
          <div class="status"><span class="dot"></span><span class="label"></span><span class="anim"></span></div>
        </div>
        <div class="uptime">
          <div class="ulabel">Uptime</div>
          <div class="uval">—</div>
        </div>
      </div>

      <div class="metrics${drives.some((d) => d.volumes && d.volumes.length) ? ' has-drive-volumes' : ''}">
        ${METRIC_KEYS.map((k) => metricRow(k, METRIC_LABELS[k])).join('')}
        ${storages.map((s, i) => metricRow(`storage_${i}`, escapeHtml(s.name).toUpperCase())).join('')}
        ${drives.map((d, i) => driveGroup(d, i)).join('')}
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

// Normalize one storage/volume config record into the shape _metricValue
// expects. Shared by metrics.storages and drives[].volumes.
function normalizeStorageItem(s, i, base) {
  return {
    entity: s.entity,
    attribute: s.attribute || null,
    total: s.total || null,
    totalAttribute: s.total_attribute || null,
    unit: s.unit || null,
    name: s.name || (i === 0 ? base : `${base} ${i + 1}`),
  };
}

function metricRow(key, label, nested) {
  return `
    <div class="metric${nested ? ' nested' : ''}" data-key="${key}">
      <div class="metric-head">
        <span class="mlabel">${label}</span>
        <span class="mval">—</span>
      </div>
      <div class="metric-bar"><div class="fill"></div></div>
    </div>
  `;
}

function driveRow(key, label) {
  return `
    <div class="drive" data-key="${key}">
      <span class="ddot"></span>
      <span class="dname">${label}</span>
      <span class="dval">—</span>
    </div>
  `;
}

// A drive rendered as a group: its health header row, then any nested
// volume usage bars beneath it. Used by the feature variant.
function driveGroup(d, i) {
  const header = driveRow(`drive_${i}`, escapeHtml(d.name).toUpperCase());
  const vols = (d.volumes || [])
    .map((v, j) => metricRow(`dvol_${i}_${j}`, escapeHtml(v.name).toUpperCase(), true))
    .join('');
  return `<div class="drive-group" data-drive="${i}">${header}${vols}</div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}



function setBtn(btn, opts) {
  // Idempotent flags — toggling to same value is a no-op.
  btn.disabled = !!opts.disabled;
  btn.classList.toggle('primary', !!opts.primary);
  btn.classList.toggle('danger',  !!opts.danger);
  btn.classList.toggle('armed',   !!opts.armed);
  // innerHTML rewrites are the expensive part — skip when the visible
  // content hasn't changed (called every 1s by the uptime ticker).
  const key = opts.busy
    ? '__busy'
    : `${opts.label}|${opts.armedLabel || ''}|${opts.iconKey}`;
  if (btn._key === key) return;
  btn._key = key;
  if (opts.busy) {
    btn.innerHTML = ICONS.spinner;
    return;
  }
  const icon = ICONS[opts.iconKey] || '';
  // Build a label stack so the button's width is determined by the
  // LONGER of (label, armedLabel) and never shifts when armed.
  // If armedLabel is null (confirmation disabled), render the normal
  // label alone — still inside the stack for layout consistency.
  const normal  = `<span class="lbl normal">${icon}<span>${opts.label}</span></span>`;
  const confirm = opts.armedLabel
    ? `<span class="lbl confirm">${icon}<span>${opts.armedLabel}</span></span>`
    : '';
  btn.innerHTML = `<span class="lbl-stack">${normal}${confirm}</span>`;
}

// ── Visual editor ───────────────────────────────────────────────────
// HA renders this in the dashboard card-edit dialog. It uses HA's
// built-in <ha-form> with a schema — gives us entity pickers, a color
// picker, toggles, dropdowns for free. <ha-form> only exists inside
// the HA frontend; outside HA (e.g. on the GitHub Pages demo) this
// class is unused.

// How many storage slots the visual editor exposes. The card itself
// accepts any number via YAML; this only caps the visible form fields.
const STORAGE_SLOTS = 3;
const DRIVE_SLOTS = 4;

const EDITOR_SCHEMA = [
  {
    name: 'variant',
    selector: { select: { mode: 'dropdown', options: [
      { value: 'tile',    label: 'Tile (compact)' },
      { value: 'chip',    label: 'Chip (Mushroom-style)' },
      { value: 'feature', label: 'Feature (full, with metric bars)' },
    ] } },
  },
  { name: 'name', selector: { text: {} } },
  { name: 'status_entity', selector: { entity: { domain: ['binary_sensor', 'sensor', 'switch'] } } },
  { name: 'uptime_entity', selector: { entity: { domain: 'sensor' } } },

  { type: 'expandable', title: 'Actions', icon: 'mdi:gesture-tap', schema: [
    { name: 'turn_on',  selector: { entity: { domain: ['switch', 'script', 'button', 'input_button'] } } },
    { name: 'sleep',    selector: { entity: { domain: ['button', 'script', 'input_button'] } } },
    { name: 'restart',  selector: { entity: { domain: ['button', 'script', 'input_button'] } } },
    { name: 'shutdown', selector: { entity: { domain: ['button', 'script', 'input_button'] } } },
  ] },

  { type: 'expandable', title: 'Confirmation', icon: 'mdi:shield-check', schema: [
    { name: 'confirm_shutdown', selector: { boolean: {} } },
    { name: 'confirm_sleep',    selector: { boolean: {} } },
    { name: 'confirm_restart',  selector: { boolean: {} } },
  ] },

  { type: 'expandable', title: 'Visible buttons', icon: 'mdi:eye', schema: [
    { name: 'show_turn_on',  selector: { boolean: {} } },
    { name: 'show_sleep',    selector: { boolean: {} } },
    { name: 'show_restart',  selector: { boolean: {} } },
    { name: 'show_shutdown', selector: { boolean: {} } },
  ] },

  { type: 'expandable', title: 'Visible metrics', icon: 'mdi:gauge', schema: [
    { name: 'show_cpu_usage', selector: { boolean: {} } },
    { name: 'show_cpu_temp',  selector: { boolean: {} } },
    { name: 'show_gpu_usage', selector: { boolean: {} } },
    { name: 'show_gpu_temp',  selector: { boolean: {} } },
    { name: 'show_ram_usage', selector: { boolean: {} } },
    { name: 'show_storage',   selector: { boolean: {} } },
    { name: 'show_drives',    selector: { boolean: {} } },
  ] },

  { type: 'expandable', title: 'Appearance', icon: 'mdi:palette', schema: [
    { name: 'icon', selector: { select: { mode: 'dropdown', options: [
      { value: 'pc',  label: 'PC (monitor)' },
      { value: 'nas', label: 'NAS (drive bays)' },
    ] } } },
    { name: 'accent_color', selector: { color_rgb: {} } },
  ] },

  { type: 'expandable', title: 'Metrics (Chip & Feature)', icon: 'mdi:chart-line', schema: [
    { name: '_metric_cpu_usage',      selector: { entity: { domain: 'sensor' } } },
    { name: '_metric_cpu_temp',       selector: { entity: { domain: 'sensor' } } },
    { name: '_metric_gpu_usage',      selector: { entity: { domain: 'sensor' } } },
    { name: '_metric_gpu_temp',       selector: { entity: { domain: 'sensor' } } },
    { name: '_metric_ram_usage',      selector: { entity: { domain: 'sensor' } } },
    { name: '_metric_ram_usage_total', selector: { entity: { domain: 'sensor' } } },
  ] },

  { type: 'expandable', title: 'Storage (multi-disk)', icon: 'mdi:harddisk', schema: [
    { name: '_storage_1_entity',          selector: { entity: { domain: 'sensor' } } },
    { name: '_storage_1_attribute',       selector: { text: {} } },
    { name: '_storage_1_total',           selector: { entity: { domain: 'sensor' } } },
    { name: '_storage_1_total_attribute', selector: { text: {} } },
    { name: '_storage_1_unit',            selector: { text: {} } },
    { name: '_storage_1_name',            selector: { text: {} } },

    { name: '_storage_2_entity',          selector: { entity: { domain: 'sensor' } } },
    { name: '_storage_2_attribute',       selector: { text: {} } },
    { name: '_storage_2_total',           selector: { entity: { domain: 'sensor' } } },
    { name: '_storage_2_total_attribute', selector: { text: {} } },
    { name: '_storage_2_unit',            selector: { text: {} } },
    { name: '_storage_2_name',            selector: { text: {} } },

    { name: '_storage_3_entity',          selector: { entity: { domain: 'sensor' } } },
    { name: '_storage_3_attribute',       selector: { text: {} } },
    { name: '_storage_3_total',           selector: { entity: { domain: 'sensor' } } },
    { name: '_storage_3_total_attribute', selector: { text: {} } },
    { name: '_storage_3_unit',            selector: { text: {} } },
    { name: '_storage_3_name',            selector: { text: {} } },
  ] },

  { type: 'expandable', title: 'Drives (NAS health)', icon: 'mdi:harddisk-plus', schema: [
    { name: '_drive_1_status', selector: { entity: { domain: 'sensor' } } },
    { name: '_drive_1_temp',   selector: { entity: { domain: 'sensor' } } },
    { name: '_drive_1_name',   selector: { text: {} } },

    { name: '_drive_2_status', selector: { entity: { domain: 'sensor' } } },
    { name: '_drive_2_temp',   selector: { entity: { domain: 'sensor' } } },
    { name: '_drive_2_name',   selector: { text: {} } },

    { name: '_drive_3_status', selector: { entity: { domain: 'sensor' } } },
    { name: '_drive_3_temp',   selector: { entity: { domain: 'sensor' } } },
    { name: '_drive_3_name',   selector: { text: {} } },

    { name: '_drive_4_status', selector: { entity: { domain: 'sensor' } } },
    { name: '_drive_4_temp',   selector: { entity: { domain: 'sensor' } } },
    { name: '_drive_4_name',   selector: { text: {} } },
  ] },
];

const EDITOR_LABELS = {
  variant: 'Variant',
  name: 'Name',
  status_entity: 'Status sensor (on = device is reachable)',
  uptime_entity: 'Uptime / last-boot sensor (optional, more accurate)',
  turn_on: 'Turn on action',
  sleep: 'Sleep action',
  restart: 'Restart action (e.g. NAS reboot button)',
  shutdown: 'Shutdown action',
  confirm_shutdown: 'Require confirm for Shutdown',
  confirm_sleep: 'Require confirm for Sleep',
  confirm_restart: 'Require confirm for Restart',
  show_turn_on: 'Show Turn on button',
  show_sleep: 'Show Sleep button',
  show_restart: 'Show Restart button',
  show_shutdown: 'Show Shut down button',
  show_cpu_usage: 'Show CPU usage',
  show_cpu_temp:  'Show CPU temp',
  show_gpu_usage: 'Show GPU usage',
  show_gpu_temp:  'Show GPU temp',
  show_ram_usage: 'Show RAM',
  show_storage:   'Show Storage',
  show_drives:    'Show Drive health',
  accent_color: 'Accent color (overrides theme)',
  icon: 'Header icon',
  _metric_cpu_usage:       'CPU usage sensor (percent)',
  _metric_cpu_temp:        'CPU temperature sensor (°C)',
  _metric_gpu_usage:       'GPU usage sensor (percent or load)',
  _metric_gpu_temp:        'GPU temperature sensor (°C)',
  _metric_ram_usage:       'RAM sensor (used / percent)',
  _metric_ram_usage_total: 'RAM total sensor (omit to show percent only)',
  _storage_1_entity:          'Disk 1 · used / percent sensor',
  _storage_1_attribute:       'Disk 1 · value attribute (e.g. UsedSpacePercentage — leave blank to use state)',
  _storage_1_total:           'Disk 1 · total sensor (omit for percent display)',
  _storage_1_total_attribute: 'Disk 1 · total attribute on the same entity (e.g. TotalSizeMB)',
  _storage_1_unit:            'Disk 1 · unit the values are ALREADY in, e.g. MB (not the display unit — card auto-scales to GB/TB)',
  _storage_1_name:            'Disk 1 · label (e.g. "System")',
  _storage_2_entity:          'Disk 2 · used / percent sensor',
  _storage_2_attribute:       'Disk 2 · value attribute',
  _storage_2_total:           'Disk 2 · total sensor',
  _storage_2_total_attribute: 'Disk 2 · total attribute',
  _storage_2_unit:            'Disk 2 · unit the values are ALREADY in, e.g. MB (auto-scales)',
  _storage_2_name:            'Disk 2 · label',
  _storage_3_entity:          'Disk 3 · used / percent sensor',
  _storage_3_attribute:       'Disk 3 · value attribute',
  _storage_3_total:           'Disk 3 · total sensor',
  _storage_3_total_attribute: 'Disk 3 · total attribute',
  _storage_3_unit:            'Disk 3 · unit the values are ALREADY in, e.g. MB (auto-scales)',
  _storage_3_name:            'Disk 3 · label',
  _drive_1_status: 'Drive 1 · status sensor', _drive_1_temp: 'Drive 1 · temperature sensor', _drive_1_name: 'Drive 1 · label',
  _drive_2_status: 'Drive 2 · status sensor', _drive_2_temp: 'Drive 2 · temperature sensor', _drive_2_name: 'Drive 2 · label',
  _drive_3_status: 'Drive 3 · status sensor', _drive_3_temp: 'Drive 3 · temperature sensor', _drive_3_name: 'Drive 3 · label',
  _drive_4_status: 'Drive 4 · status sensor', _drive_4_temp: 'Drive 4 · temperature sensor', _drive_4_name: 'Drive 4 · label',
};

class PcControlCardEditor extends HTMLElementBase {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  setConfig(config) {
    this._config = config || {};
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  // Flatten metrics.* → _metric_* and metrics.storages[] → _storage_N_*
  // so the form has one field per row. Always runs the migration
  // first so a pre-1.1 config opened in the visual editor still
  // surfaces with its entity ids populated.
  _flatten(config) {
    const migrated = migrateConfig(config || {});
    const m = migrated.metrics || {};
    const flat = { ...migrated };
    for (const k of METRIC_KEYS) flat[`_metric_${k}`] = m[k];
    flat._metric_ram_usage_total = m.ram_usage_total;

    const storages = Array.isArray(m.storages) ? m.storages : [];
    for (let i = 0; i < STORAGE_SLOTS; i++) {
      const s = storages[i] || {};
      flat[`_storage_${i + 1}_entity`]          = s.entity;
      flat[`_storage_${i + 1}_attribute`]       = s.attribute;
      flat[`_storage_${i + 1}_total`]           = s.total;
      flat[`_storage_${i + 1}_total_attribute`] = s.total_attribute;
      flat[`_storage_${i + 1}_unit`]            = s.unit;
      flat[`_storage_${i + 1}_name`]            = s.name;
    }

    const drives = Array.isArray(migrated.drives) ? migrated.drives : [];
    for (let i = 0; i < DRIVE_SLOTS; i++) {
      const d = drives[i] || {};
      flat[`_drive_${i + 1}_status`] = d.status;
      flat[`_drive_${i + 1}_temp`]   = d.temp;
      flat[`_drive_${i + 1}_name`]   = d.name;
    }
    return flat;
  }

  // Convert form data back to the canonical config shape.
  _unflatten(value) {
    const next = { ...value };
    const metrics = {};
    for (const k of METRIC_KEYS) {
      const v = next[`_metric_${k}`];
      if (v) metrics[k] = v;
      delete next[`_metric_${k}`];
    }
    if (next._metric_ram_usage_total) metrics.ram_usage_total = next._metric_ram_usage_total;
    delete next._metric_ram_usage_total;

    const storages = [];
    for (let i = 1; i <= STORAGE_SLOTS; i++) {
      const entity = next[`_storage_${i}_entity`];
      if (entity) {
        const item = { entity };
        if (next[`_storage_${i}_attribute`])       item.attribute       = next[`_storage_${i}_attribute`];
        if (next[`_storage_${i}_total`])           item.total           = next[`_storage_${i}_total`];
        if (next[`_storage_${i}_total_attribute`]) item.total_attribute = next[`_storage_${i}_total_attribute`];
        if (next[`_storage_${i}_unit`])            item.unit            = next[`_storage_${i}_unit`];
        if (next[`_storage_${i}_name`])            item.name            = next[`_storage_${i}_name`];
        storages.push(item);
      }
      delete next[`_storage_${i}_entity`];
      delete next[`_storage_${i}_attribute`];
      delete next[`_storage_${i}_total`];
      delete next[`_storage_${i}_total_attribute`];
      delete next[`_storage_${i}_unit`];
      delete next[`_storage_${i}_name`];
    }
    if (storages.length) metrics.storages = storages;
    if (Object.keys(metrics).length) next.metrics = metrics;
    else delete next.metrics;

    const drives = [];
    for (let i = 1; i <= DRIVE_SLOTS; i++) {
      const status = next[`_drive_${i}_status`];
      if (status) {
        const item = { status };
        if (next[`_drive_${i}_temp`]) item.temp = next[`_drive_${i}_temp`];
        if (next[`_drive_${i}_name`]) item.name = next[`_drive_${i}_name`];
        // The form has no fields for nested volumes; preserve any from the
        // current config (matched by slot↔drive index) so editing in the
        // UI doesn't strip a grouped Drive→Volumes layout.
        const prevVolumes = this._config?.drives?.[i - 1]?.volumes;
        if (Array.isArray(prevVolumes) && prevVolumes.length) item.volumes = prevVolumes;
        drives.push(item);
      }
      delete next[`_drive_${i}_status`];
      delete next[`_drive_${i}_temp`];
      delete next[`_drive_${i}_name`];
    }
    if (drives.length) next.drives = drives;
    else delete next.drives;
    return next;
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (this.shadowRoot.childNodes.length) {
      // Update existing form with fresh data
      const form = this.shadowRoot.querySelector('ha-form');
      if (form) {
        form.hass = this._hass;
        form.data = this._flatten(this._config);
      }
      return;
    }
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display: block; padding: 4px 0;';
    const form = document.createElement('ha-form');
    form.hass = this._hass;
    form.data = this._flatten(this._config);
    form.schema = EDITOR_SCHEMA;
    form.computeLabel = (s) => EDITOR_LABELS[s.name] || s.name;
    form.addEventListener('value-changed', (e) => {
      const next = this._unflatten(e.detail.value);
      this._config = next;
      this.dispatchEvent(new CustomEvent('config-changed', {
        detail: { config: next },
        bubbles: true,
        composed: true,
      }));
    });
    wrap.appendChild(form);
    this.shadowRoot.appendChild(wrap);
  }
}

// ── Register ────────────────────────────────────────────────────────
// Guarded so importing this module under Node (for tests) is a no-op —
// these globals only exist in the browser.

if (typeof customElements !== 'undefined') {
  if (!customElements.get('pc-control-card-editor')) {
    customElements.define('pc-control-card-editor', PcControlCardEditor);
  }
  if (!customElements.get('pc-control-card')) {
    customElements.define('pc-control-card', PcControlCard);
  }
}

if (typeof window !== 'undefined') {
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'pc-control-card',
    name: 'PC Control Card',
    description: 'Tile, chip, or full feature card for controlling a PC (turn on / sleep / shutdown) with live CPU/RAM/GPU metrics.',
    preview: false,
  });

  /* eslint-disable no-console */
  console.info(
    `%c PC-CONTROL-CARD %c v${CARD_VERSION} `,
    'color: white; background: #3a7bd5; font-weight: 700; border-radius: 3px 0 0 3px; padding: 1px 4px;',
    'color: #3a7bd5; background: #f1f5f9; border-radius: 0 3px 3px 0; padding: 1px 4px;'
  );
}
