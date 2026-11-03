---
version: alpha
name: Cairnboard Bento Dark
description: Cairnboard Bento Dark theme (dark). Same token names as every other theme.
colors:
  canvas: "#000000"
  surface: "#161618"
  surface-inset: "#222226"
  surface-inset-2: "#2c2c31"
  line: "rgba(255, 255, 255, 0.1)"
  line-strong: "rgba(255, 255, 255, 0.18)"
  material: "rgba(0, 0, 0, 0.7)"
  pill-bg: "#1b1b1e"
  pill-indicator: "#3a3a3f"
  text: "#f5f5f7"
  text-2: "#c7c7cc"
  text-3: "#9a9aa2"
  link: "#5eaaff"
  focus: "#5eaaff"
  focus-bg: "#11294a"
  on-accent: "#000000"
  primary: "#5eaaff"
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
  page-title: { fontFamily: Inter Variable, fontSize: 46.4px, fontWeight: 700, lineHeight: 1.06, letterSpacing: -0.03em }
  display: { fontFamily: Inter Variable, fontSize: 32px, fontWeight: 650, lineHeight: 1.15, letterSpacing: -0.02em }
  stat: { fontFamily: Inter Variable, fontSize: 28px, fontWeight: 700, lineHeight: 1.1, letterSpacing: -0.02em }
  project-title: { fontFamily: Inter Variable, fontSize: 24px, fontWeight: 700, lineHeight: 1.1, letterSpacing: -0.025em }
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
  header-height: 56px
  header-height-wide: 68px
  nav-height: 48px
  search-width: 240px
components:
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

Bento Dark is a dark theme for Cairnboard. It changes colors and shadows only; shape, spacing, typography and motion
come from the root `DESIGN.md` and are the same in every theme. Token names match the root file one to one.

## Elevation & Depth

```yaml
shadow-box: 0 0 0 1px rgba(255, 255, 255, 0.06)
shadow-box-raised: 0 0 0 1px rgba(255, 255, 255, 0.1), 0 18px 40px rgba(0, 0, 0, 0.6)
shadow-indicator: 0 1px 3px rgba(0, 0, 0, 0.5)
```
