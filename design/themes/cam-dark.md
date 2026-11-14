---
version: alpha
name: Cairnboard Cam Dark
description: Cairnboard Cam Dark theme (dark). Same token names as every other theme.
colors:
  canvas: "#0a101b"
  surface: "#131b2b"
  surface-inset: "#1d273c"
  surface-inset-2: "#283652"
  line: "rgba(210, 226, 255, 0.11)"
  line-strong: "rgba(210, 226, 255, 0.22)"
  material: "#0e1522"
  pill-bg: "#1a2438"
  pill-indicator: "#334464"
  glass-surface: "rgba(16, 23, 36, 0.70)"
  glass-surface-inset: "rgba(28, 39, 60, 0.72)"
  glass-surface-inset-2: "rgba(40, 54, 80, 0.86)"
  glass-material: "rgba(12, 18, 30, 0.74)"
  glass-pill-bg: "rgba(22, 31, 49, 0.76)"
  glass-pill-indicator: "rgba(54, 72, 104, 0.90)"
  glass-column: "rgba(14, 21, 34, 0.64)"
  glass-card: "rgba(25, 35, 55, 0.82)"
  glass-rim: "rgba(206, 224, 255, 0.16)"
  glass-highlight: "rgba(255, 255, 255, 0.22)"
  glass-row-hover: "rgba(210, 226, 255, 0.08)"
  text: "#f2f5fb"
  text-2: "#cbd3e2"
  text-3: "#9ea9c0"
  link: "#7cb7ff"
  focus: "#7cb7ff"
  focus-bg: "#263751"
  on-accent: "#08101c"
  primary: "#7cb7ff"
  tone-1: "#8f8bff"
  tone-1-text: "#b4b1ff"
  tone-1-bg: "#23224a"
  tone-2: "#3fd0b2"
  tone-2-text: "#7fe3cd"
  tone-2-bg: "#0f3029"
  tone-3: "#ffb54d"
  tone-3-text: "#ffc879"
  tone-3-bg: "#3a2810"
  tone-4: "#4cc0f0"
  tone-4-text: "#8ad6f7"
  tone-4-bg: "#0d2a3a"
  tone-5: "#e07fc8"
  tone-5-text: "#f0a6dc"
  tone-5-bg: "#3a1b33"
  tone-6: "#ff7a88"
  tone-6-text: "#ff9ea8"
  tone-6-bg: "#3d1a1e"
  tone-7: "#a3a9ba"
  tone-7-text: "#b9c1da"
  tone-7-bg: "#252a38"
  tone-8: "#6fcf7c"
  tone-8-text: "#9be3a5"
  tone-8-bg: "#13301a"
  done: "#6fdc96"
  done-bg: "#133222"
  doing: "#6eb4ff"
  doing-bg: "#11294a"
  planned: "#b5b5bd"
  planned-bg: "#2a2a2f"
  urgent: "#ff8f85"
  urgent-bg: "#401714"
  important: "#ffd36b"
  important-bg: "#3a2d08"
  warning: "#ffc879"
  warning-bg: "#3a2810"
  danger: "#ff8a80"
  danger-bg: "#3d1a1e"
typography:
  hero: { fontFamily: Inter Variable, fontSize: 72px, fontWeight: 700, lineHeight: 1, letterSpacing: -0.045em }
  page-title: { fontFamily: Inter Variable, fontSize: 46.4px, fontWeight: 700,
    lineHeight: 1.06, letterSpacing: -0.03em }
  display: { fontFamily: Inter Variable, fontSize: 32px, fontWeight: 650, lineHeight: 1.15, letterSpacing: -0.02em }
  stat: { fontFamily: Inter Variable, fontSize: 28px, fontWeight: 700, lineHeight: 1.1, letterSpacing: -0.02em }
  project-title: { fontFamily: Inter Variable, fontSize: 24px, fontWeight: 700,
    lineHeight: 1.1, letterSpacing: -0.025em }
  title: { fontFamily: Inter Variable, fontSize: 20px, fontWeight: 600, lineHeight: 1.3, letterSpacing: -0.01em }
  box-title: { fontFamily: Inter Variable, fontSize: 19px, fontWeight: 650, lineHeight: 1.25, letterSpacing: -0.015em }
  lead: { fontFamily: Inter Variable, fontSize: 17px, fontWeight: 400, lineHeight: 1.6 }
  body: { fontFamily: Inter Variable, fontSize: 16px, fontWeight: 400, lineHeight: 1.7 }
  row: { fontFamily: Inter Variable, fontSize: 15.5px, fontWeight: 400, lineHeight: 1.5 }
  ui: { fontFamily: Inter Variable, fontSize: 15px, fontWeight: 500, lineHeight: 1.4 }
  small: { fontFamily: Inter Variable, fontSize: 14px, fontWeight: 400, lineHeight: 1.45 }
  label: { fontFamily: Inter Variable, fontSize: 13px, fontWeight: 550, lineHeight: 1.3 }
  caption: { fontFamily: Inter Variable, fontSize: 12px, fontWeight: 500, lineHeight: 1.3 }
  code: { fontFamily: ui-monospace, fontSize: 14px, fontWeight: 400, lineHeight: 1.6 }
rounded:
  xs: 6px
  sm: 12px
  md: 20px
  lg: 28px
  full: 999px
spacing:
  hairline: 1px
  2xs: 2px
  xs: 4px
  6: 6px
  sm: 8px
  10: 10px
  12: 12px
  14: 14px
  md: 16px
  18: 18px
  lg: 24px
  28: 28px
  xl: 40px
  content-max: 1080px
  page-max: 1152px
  overview-max: 1184px
  header-height: 56px
  header-height-wide: 68px
  nav-height: 48px
  search-width: 240px
components:
  glass-box:
    backgroundColor: "{colors.glass-surface}"
    textColor: "{colors.text}"
  glass-box-secondary:
    backgroundColor: "{colors.glass-surface}"
    textColor: "{colors.text-2}"
  glass-box-muted:
    backgroundColor: "{colors.glass-surface}"
    textColor: "{colors.text-3}"
  glass-box-link:
    backgroundColor: "{colors.glass-surface}"
    textColor: "{colors.link}"
  glass-inset:
    backgroundColor: "{colors.glass-surface-inset}"
    textColor: "{colors.text}"
  glass-inset-muted:
    backgroundColor: "{colors.glass-surface-inset-2}"
    textColor: "{colors.text-3}"
  glass-header:
    backgroundColor: "{colors.glass-material}"
    textColor: "{colors.text}"
  glass-pill:
    backgroundColor: "{colors.glass-pill-bg}"
    textColor: "{colors.text}"
  glass-pill-active:
    backgroundColor: "{colors.glass-pill-indicator}"
    textColor: "{colors.text}"
  glass-column:
    backgroundColor: "{colors.glass-column}"
    textColor: "{colors.text-2}"
  glass-card:
    backgroundColor: "{colors.glass-card}"
    textColor: "{colors.text}"
  glass-card-muted:
    backgroundColor: "{colors.glass-card}"
    textColor: "{colors.text-3}"
  glass-row-hover-mark:
    backgroundColor: "{colors.glass-row-hover}"
  glass-rim-mark:
    backgroundColor: "{colors.glass-rim}"
  glass-highlight-mark:
    backgroundColor: "{colors.glass-highlight}"
  page:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text}"
  page-muted:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text-3}"
  box:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
  box-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-2}"
  box-muted:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-3}"
  box-link:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.link}"
  inset:
    backgroundColor: "{colors.surface-inset}"
    textColor: "{colors.text}"
  inset-muted:
    backgroundColor: "{colors.surface-inset-2}"
    textColor: "{colors.text-3}"
  button-primary:
    backgroundColor: "{colors.focus}"
    textColor: "{colors.on-accent}"
  selected:
    backgroundColor: "{colors.focus-bg}"
    textColor: "{colors.text}"
  tone-1-chip:
    backgroundColor: "{colors.tone-1-bg}"
    textColor: "{colors.tone-1-text}"
  tone-2-chip:
    backgroundColor: "{colors.tone-2-bg}"
    textColor: "{colors.tone-2-text}"
  tone-3-chip:
    backgroundColor: "{colors.tone-3-bg}"
    textColor: "{colors.tone-3-text}"
  tone-4-chip:
    backgroundColor: "{colors.tone-4-bg}"
    textColor: "{colors.tone-4-text}"
  tone-5-chip:
    backgroundColor: "{colors.tone-5-bg}"
    textColor: "{colors.tone-5-text}"
  tone-6-chip:
    backgroundColor: "{colors.tone-6-bg}"
    textColor: "{colors.tone-6-text}"
  tone-7-chip:
    backgroundColor: "{colors.tone-7-bg}"
    textColor: "{colors.tone-7-text}"
  tone-8-chip:
    backgroundColor: "{colors.tone-8-bg}"
    textColor: "{colors.tone-8-text}"
  done-chip:
    backgroundColor: "{colors.done-bg}"
    textColor: "{colors.done}"
  doing-chip:
    backgroundColor: "{colors.doing-bg}"
    textColor: "{colors.doing}"
  planned-chip:
    backgroundColor: "{colors.planned-bg}"
    textColor: "{colors.planned}"
  urgent-chip:
    backgroundColor: "{colors.urgent-bg}"
    textColor: "{colors.urgent}"
  important-chip:
    backgroundColor: "{colors.important-bg}"
    textColor: "{colors.important}"
  warning-chip:
    backgroundColor: "{colors.warning-bg}"
    textColor: "{colors.warning}"
  danger-chip:
    backgroundColor: "{colors.danger-bg}"
    textColor: "{colors.danger}"
  pill:
    backgroundColor: "{colors.pill-bg}"
    textColor: "{colors.text}"
  pill-active:
    backgroundColor: "{colors.pill-indicator}"
    textColor: "{colors.text}"
  header:
    backgroundColor: "{colors.material}"
    textColor: "{colors.text}"
  tone-1-mark:
    backgroundColor: "{colors.tone-1}"
  tone-2-mark:
    backgroundColor: "{colors.tone-2}"
  tone-3-mark:
    backgroundColor: "{colors.tone-3}"
  tone-4-mark:
    backgroundColor: "{colors.tone-4}"
  tone-5-mark:
    backgroundColor: "{colors.tone-5}"
  tone-6-mark:
    backgroundColor: "{colors.tone-6}"
  tone-7-mark:
    backgroundColor: "{colors.tone-7}"
  tone-8-mark:
    backgroundColor: "{colors.tone-8}"
  divider:
    backgroundColor: "{colors.line}"
  divider-strong:
    backgroundColor: "{colors.line-strong}"
---
## Overview

Cam is a dark theme for Cairnboard: frosted glass boxes over a dithered pixel horizon. It changes colors and
shadows only; shape, spacing, typography and motion come from the root `DESIGN.md`. The plain color tokens hold the
opaque fallback used when backdrop blur is missing or the reader asks for reduced transparency or more contrast; the
`glass-*` tokens hold the translucent layers, and `test/glass-contrast.test.mjs` checks them against every color of
the scene image.

## Elevation & Depth

```yaml
shadow-box: 0 0 0 1px rgba(4, 8, 16, 0.60), 0 8px 24px rgba(2, 5, 12, 0.44), 0 20px 44px rgba(2, 5, 12, 0.36)
shadow-box-raised: 0 0 0 1px rgba(124, 183, 255, 0.24), 0 20px 48px rgba(2, 5, 12, 0.6)
shadow-indicator: 0 0 0 1px rgba(206, 224, 255, 0.14), 0 2px 6px rgba(0, 0, 0, 0.48)
```
