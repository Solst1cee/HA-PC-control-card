# NAS / Synology support — Design

**Date:** 2026-05-25
**Status:** Approved, pending implementation plan
**Target version:** `1.1.0`

## Goal

Add first-class NAS support to the PC Control Card, primarily for Synology
DSM, covering the user's requested features:

- **Uptime and status**
- **Storage used / total** — at both the **volume** level (usage bars) and the
  **physical-disk** level (drive health + temperature)
- **Power functions:** turn on, **restart**, turn off

## Guiding principle

The card is and remains a **thin presentation layer**. It reads Home Assistant
entities and calls HA services; it never communicates with the NAS directly.
All NAS data arrives through Home Assistant integrations. The only computation
the card performs beyond formatting is a single **bounded healthy-drive count**
for the chip's drive summary — no other aggregation is introduced.

## Data sourcing (no agent required)

There is **no need to install HASS.agent (or any agent) on the Synology**. Home
Assistant's built-in **Synology DSM** integration (official core, config-flow)
exposes everything needed via the DSM API. Verified against the official
integration documentation:

| Need | Synology DSM entity | Notes |
|---|---|---|
| Restart | **Reboot** button | native |
| Turn off | **Shutdown** button | native |
| Turn on | — | **not possible** via the integration (box is off); use **Wake-on-LAN**, same as a PC |
| Uptime | **Uptime** sensor | **disabled by default** — user must enable it |
| Volume used | Volume *Used size* sensor | enabled by default |
| Volume total | Volume *Total size* sensor | **disabled by default** — enable for used/total bars |
| Volume % | Volume *Usage* sensor | enabled by default; usable without total (percent display) |
| Drive status | per-disk *Status* sensor | text, e.g. `normal` |
| Drive temp | per-disk *Temperature* sensor | °C |
| CPU / RAM / temp | CPU utilization, Memory %, Internal temperature | for the existing metric bars |

The status sensor for a NAS stays a **ping `binary_sensor`** (`on` = reachable),
exactly as for a PC. The Synology integration's own entities go `unavailable`
when the NAS is off, but it provides no dedicated connectivity binary sensor, so
a ping is the cleanest source of truth for on/off.

## New configuration surface

All additions are optional and backward-compatible. Defaults are chosen so that
**existing PC card configs render identically** after the upgrade.

| Key | Type | Default | Purpose |
|---|---|---|---|
| `restart` | action: entity_id or `{ entity, service }` | — | the reboot action, e.g. `button.nas_reboot` |
| `show_restart` | boolean | `false` | hidden by default so existing 3-button PC cards are unchanged; the NAS preset sets `true` |
| `confirm_restart` | boolean | `true` | require a 2-tap confirm (reboot interrupts service) |
| `uptime_entity` | sensor entity | — | accurate uptime source; falls back to `status_entity.last_changed` when omitted |
| `drives` | array of `{ status, temp?, name? }` | — | one entry per physical disk; `status` is the text status sensor, `temp` the optional °C sensor |
| `show_drives` | boolean | `true` | drive section only renders when `drives` is non-empty |
| `healthy_states` | string[] | `['normal','ok','healthy','good']` | case-insensitive; any status outside this set renders a red (alert) dot |
| `icon` | `'pc'` \| `'nas'` | `'pc'` | selects the header glyph; `'nas'` is a drive-stack icon |

Action parsing reuses the existing `parseAction` helper. `button.*` already maps
to `button.press`, so `button.nas_reboot` works with no parser changes.

## Restart action + state machine

- Button row order becomes **On · Sleep · Restart · Shut down** (up to four).
  A PC hides Restart (`show_restart: false`, the default); a NAS hides Sleep
  (`show_sleep: false`). The existing `flex: 1` button layout handles widths;
  the tile variant uses the existing `compact` button style.
- New pending overlay state `restart` → displayed status **"Restarting"**, tone
  `warm`, pulsing. Added to the `META` table.
- New `restart` icon (circular-arrows / refresh) added to `ICONS`; wired into
  `setBtn`.
- New action handler `_onRestart()`: no-op unless `status === 'on'`, no pending
  action, and a `restart` action is configured. Honors `confirm_restart` via the
  existing arm/disarm flow (a new `_armed.restart`).
- **Resolution logic** (in `set hass`): a NAS reboot takes the box down then
  brings it back up.
  - On press: `pending = 'restart'`, `_restartDipped = false`.
  - When `status_entity` state becomes **`!== 'on'`** (catches both `off` and
    `unavailable` from Synology entities) → set `_restartDipped = true`.
  - Once `_restartDipped` is true **and** state is `'on'` again → clear pending.
  - Fallback: clear pending after `RESTART_TIMEOUT_MS` (≈ 300 s — NAS reboots
    are slower than a PC boot) to avoid a stuck overlay if the status sensor's
    poll interval never catches the dip.

## Uptime sourcing

`_uptime()` gains an `uptime_entity` path while preserving current behavior:

1. If `uptime_entity` is configured and the device is on:
   - If the entity's `device_class === 'timestamp'` **or** its state parses as a
     valid date → uptime = `now − parsed_time`.
   - Else treat the numeric state as a **duration**, unit-aware:
     `d`/`days` → days, `h` → hours, `min`/`m` → minutes, otherwise **seconds**
     (Synology's Uptime sensor reports seconds).
   - Format with the existing `fmtUptime`.
2. Otherwise fall back to the current `status_entity.last_changed` derivation.

## Drive health display (new display type)

Drive health is a non-bar display: a colored status dot plus a temperature.
Health color uses `--success-color` (green, with a sensible fallback) for
healthy and the existing `--error-color` (`--spc-alert`) for unhealthy.

- **Feature variant:** a "Drives" section rendered **below** the storage bars.
  One row per disk: health dot + drive name + temperature value (or the raw
  status text when no `temp` entity is configured). No progress bar.
- **Chip variant:** a single summary mini-stat — label `DRIVES`, value
  `healthy/total` (e.g. `4/4`), turning red when any drive is unhealthy. The
  healthy count is the only aggregation the card performs (bounded, O(n) count).
- **Tile variant:** no drive display (tile stays minimal).

A `drives` array is normalized like `storages` (filter out entries without a
`status`, default names `Drive`, `Drive 2`, …). Health is computed by lowercasing
the status state and testing membership in `healthy_states`.

## Visual editor

Extend the existing `ha-form` schema and the flatten/unflatten round-trip:

- **Actions** expandable: add a `restart` entity picker (`button` / `script` /
  `input_button`).
- **Confirmation** expandable: add `confirm_restart`.
- **Visible buttons** expandable: add `show_restart`.
- **Visible metrics** expandable: add `show_drives`.
- New **"Drives (NAS)"** expandable with a fixed number of visible slots
  (`DRIVE_SLOTS`, e.g. 4), each exposing `status` / `temp` / `name`, flattened to
  `_drive_N_*` and unflattened back into the `drives` array — mirroring the
  existing `_storage_N_*` handling. YAML still accepts any number of drives.
- Add the corresponding `EDITOR_LABELS`.
- `icon` selector (dropdown `pc` / `nas`) added to the Appearance expandable.

## Backward compatibility

No new migration is required. Every addition is optional with a default that
preserves current rendering:

- `show_restart` defaults to `false` → existing PC cards keep their 3-button row.
- No `drives` array → no drive section; `show_drives` is inert.
- No `uptime_entity` → uptime still derives from `last_changed`.
- `icon` defaults to `pc`.

The existing `migrateConfig` (pre-1.1 `cpu`/`ram`/`gpu` → namespaced keys) is
untouched.

## Documentation & demo

- Rewrite the README **"NAS / multi-disk setup"** section into a proper
  **Synology** section:
  - State that no agent is needed; the Synology DSM integration provides the
    data, with Wake-on-LAN for power-on.
  - Call out that the **Uptime** sensor and **Volume Total size** sensor are
    **disabled by default** and must be enabled.
  - Provide a complete NAS preset YAML: ping `binary_sensor` status, WOL switch
    `turn_on`, `button.*_reboot` restart, `button.*_shutdown` shutdown,
    `uptime_entity`, volume `storages`, and `drives`.
  - Document all new config keys in the configuration table.
- Sync `docs/pc-control-card.js` (the GitHub Pages demo copy) with the updated
  card, and add a NAS example to `docs/index.html`.
- Bump `CARD_VERSION` and `package.json` version to **`1.1.0`**.

## Testing

The project currently has no tests and ships a single file with no build step.
Add **dev-only** testing that does not affect the distributed artifact:

- Add `jsdom` and use the built-in `node:test` runner as **devDependencies**
  (`package.json` `devDependencies` + a `test` script). The shipped
  `pc-control-card.js` stays a single dependency-free file; the "no build step /
  no external dependencies" promise applies to the card itself and is preserved.
- Unit tests for the new pure logic:
  - uptime parsing — timestamp vs numeric-seconds vs unit-aware duration;
  - drive health mapping (`healthy_states`, case-insensitivity);
  - `parseAction` for the `restart` action.
- DOM smoke tests under jsdom:
  - a NAS config renders the **Restart** button and the **Drives** section;
  - an existing PC config renders **unchanged** (no Restart button, no Drives).

If keeping the repo dependency-free even for development is preferred, fall back
to manual verification through the demo page instead.

## Out of scope (possible follow-ups)

- Aggregated "hottest disk temperature" / pool-summary computations beyond the
  bounded healthy-drive count (would break the thin-layer principle).
- A fully generic, free-form action-button list (the fixed slots + optional
  Restart cover the need without a schema overhaul).
- SNMP / non-Synology NAS presets (the card stays source-agnostic, so any
  integration that produces the right entities already works; only the *preset
  and docs* are Synology-specific).
