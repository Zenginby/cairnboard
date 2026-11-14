---
version: alpha
name: Cairnboard Paper
description: Cairnboard Paper theme (light). Same token names as every other theme.
colors:
  canvas: "#f3eee4"
  surface: "#fffcf5"
  surface-inset: "#f7f2e8"
  surface-inset-2: "#ede6d8"
  line: "rgba(60, 40, 20, 0.1)"
  line-strong: "rgba(60, 40, 20, 0.18)"
  material: "rgba(243, 238, 228, 0.75)"
  pill-bg: "#e6dfd2"
  pill-indicator: "#fffcf5"
  glass-surface: "#fffcf5"
  glass-surface-inset: "#f7f2e8"
  glass-surface-inset-2: "#ede6d8"
  glass-material: "rgba(243, 238, 228, 0.75)"
  glass-pill-bg: "#e6dfd2"
  glass-pill-indicator: "#fffcf5"
  glass-column: "#f7f2e8"
  glass-card: "#fffcf5"
  glass-rim: "rgba(60, 40, 20, 0.1)"
  glass-highlight: "rgba(60, 40, 20, 0.1)"
  glass-row-hover: "#f7f2e8"
  text: "#2a251f"
  text-2: "#4d463c"
  text-3: "#6b6255"
  link: "#94471a"
  focus: "#a8551f"
  focus-bg: "#f6e5d3"
  on-accent: "#ffffff"
  primary: "#a8551f"
  tone-1: "#7d6fd6"
  tone-1-text: "#4f43a8"
  tone-1-bg: "#eeeaf8"
  tone-2: "#2f9a80"
  tone-2-text: "#16614f"
  tone-2-bg: "#e2f1ea"
  tone-3: "#d98f2b"
  tone-3-text: "#844600"
  tone-3-bg: "#faecd6"
  tone-4: "#2f8fb8"
  tone-4-text: "#115a7a"
  tone-4-bg: "#e0eff5"
  tone-5: "#c4527f"
  tone-5-text: "#8c2556"
  tone-5-bg: "#f7e5ec"
  tone-6: "#d0603c"
  tone-6-text: "#97361b"
  tone-6-bg: "#f9e6dd"
  tone-7: "#4a8f4f"
  tone-7-text: "#28632d"
  tone-7-bg: "#e5f0e2"
  tone-8: "#857c6e"
  tone-8-text: "#555044"
  tone-8-bg: "#ece8df"
  done: "#25713f"
  done-bg: "#e2efe1"
  doing: "#8a4614"
  doing-bg: "#f6e5d3"
  planned: "#5f584c"
  planned-bg: "#ece6da"
  urgent: "#a8291f"
  urgent-bg: "#f9e1db"
  important: "#7d5000"
  important-bg: "#faedc6"
  warning: "#855500"
  warning-bg: "#f9ecd5"
  danger: "#a8291f"
  danger-bg: "#f8e3de"
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

Paper is a light theme for Cairnboard. It changes colors and shadows only; shape, spacing, typography and motion
come from the root `DESIGN.md` and are the same in every theme. Token names match the root file one to one.

## Elevation & Depth

```yaml
shadow-box: 0 1px 2px rgba(60, 40, 20, 0.05), 0 8px 24px rgba(60, 40, 20, 0.07)
shadow-box-raised: 0 2px 4px rgba(60, 40, 20, 0.06), 0 18px 40px rgba(60, 40, 20, 0.12)
shadow-indicator: 0 1px 3px rgba(0, 0, 0, 0.12)
```
