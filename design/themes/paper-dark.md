---
version: alpha
name: Cairnboard Paper Dark
description: Cairnboard Paper Dark theme (dark). Same token names as every other theme.
colors:
  canvas: "#17140f"
  surface: "#221e18"
  surface-inset: "#2b2620"
  surface-inset-2: "#352f27"
  line: "rgba(255, 240, 220, 0.09)"
  line-strong: "rgba(255, 240, 220, 0.16)"
  material: "rgba(23, 20, 15, 0.75)"
  pill-bg: "#2e2922"
  pill-indicator: "#3d362c"
  text: "#f1eadf"
  text-2: "#cfc5b6"
  text-3: "#a89e8f"
  link: "#e9a66b"
  focus: "#e9a66b"
  focus-bg: "#3b2a1a"
  on-accent: "#000000"
  primary: "#e9a66b"
  tone-1: "#9c91f0"
  tone-1-text: "#bdb5f8"
  tone-1-bg: "#2d283f"
  tone-2: "#4cc0a2"
  tone-2-text: "#86d9c3"
  tone-2-bg: "#1a3029"
  tone-3: "#f0b158"
  tone-3-text: "#f5c987"
  tone-3-bg: "#3c2e1b"
  tone-4: "#5bb3d8"
  tone-4-text: "#93cde6"
  tone-4-bg: "#1a2e38"
  tone-5: "#e57fae"
  tone-5-text: "#f0a9ca"
  tone-5-bg: "#3b2230"
  tone-6: "#f08d6c"
  tone-6-text: "#f6b39c"
  tone-6-bg: "#3e261c"
  tone-7: "#7cc286"
  tone-7-text: "#a2d8a9"
  tone-7-bg: "#1f3222"
  tone-8: "#b0a593"
  tone-8-text: "#cbc1b0"
  tone-8-bg: "#332e26"
  done: "#7fd39c"
  done-bg: "#1c3324"
  doing: "#e9a66b"
  doing-bg: "#3b2a1a"
  planned: "#c4bbad"
  planned-bg: "#332e26"
  urgent: "#ff9a8c"
  urgent-bg: "#44221c"
  important: "#f5cf73"
  important-bg: "#3d3117"
  warning: "#f5c987"
  warning-bg: "#3c2e1b"
  danger: "#ff958b"
  danger-bg: "#432423"
typography:
  display: { fontFamily: Inter Variable, fontSize: 32px, fontWeight: 650, lineHeight: 1.15, letterSpacing: -0.02em }
  title: { fontFamily: Inter Variable, fontSize: 20px, fontWeight: 600, lineHeight: 1.3, letterSpacing: -0.01em }
  body: { fontFamily: Inter Variable, fontSize: 16px, fontWeight: 400, lineHeight: 1.7 }
  label: { fontFamily: Inter Variable, fontSize: 13px, fontWeight: 550, lineHeight: 1.3 }
  code: { fontFamily: ui-monospace, fontSize: 14px, fontWeight: 400, lineHeight: 1.6 }
rounded:
  sm: 12px
  md: 20px
  lg: 28px
  full: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
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

Paper Dark is a dark theme for Cairnboard. It changes colors and shadows only; shape, spacing, typography and motion
come from the root `DESIGN.md` and are the same in every theme. Token names match the root file one to one.

## Elevation & Depth

```yaml
shadow-box: 0 0 0 1px rgba(255, 240, 220, 0.06)
shadow-box-raised: 0 0 0 1px rgba(255, 240, 220, 0.1), 0 18px 40px rgba(0, 0, 0, 0.55)
```
