---
version: alpha
name: Cairnboard Graphite
description: Cairnboard Graphite theme (dark). Same token names as every other theme.
colors:
  canvas: "#1b1c1f"
  surface: "#25262a"
  surface-inset: "#2e2f34"
  surface-inset-2: "#38393f"
  line: "rgba(255, 255, 255, 0.08)"
  line-strong: "rgba(255, 255, 255, 0.15)"
  material: "rgba(27, 28, 31, 0.75)"
  pill-bg: "#34353b"
  pill-indicator: "#43444b"
  text: "#e7e7ea"
  text-2: "#bdbec5"
  text-3: "#a6a7b0"
  link: "#86b6ff"
  focus: "#86b6ff"
  focus-bg: "#21334f"
  on-accent: "#000000"
  primary: "#86b6ff"
  tone-1: "#9a96f5"
  tone-1-text: "#bcb9fb"
  tone-1-bg: "#2e2d4c"
  tone-2: "#4cc4a8"
  tone-2-text: "#86dcc7"
  tone-2-bg: "#1a3631"
  tone-3: "#f0b158"
  tone-3-text: "#f5c987"
  tone-3-bg: "#3c3020"
  tone-4: "#5cb8e0"
  tone-4-text: "#93d0ec"
  tone-4-bg: "#1a3240"
  tone-5: "#e57fae"
  tone-5-text: "#f0a9ca"
  tone-5-bg: "#3d2533"
  tone-6: "#f08d6c"
  tone-6-text: "#f6b39c"
  tone-6-bg: "#40291f"
  tone-7: "#77c482"
  tone-7-text: "#a0d9a8"
  tone-7-bg: "#1e3523"
  tone-8: "#a6abb9"
  tone-8-text: "#c1c6d4"
  tone-8-bg: "#30333d"
  done: "#79d39a"
  done-bg: "#1d3627"
  doing: "#86b6ff"
  doing-bg: "#21334f"
  planned: "#b9bac1"
  planned-bg: "#33343a"
  urgent: "#ff9a90"
  urgent-bg: "#45221f"
  important: "#f5cf73"
  important-bg: "#3e3318"
  warning: "#f5c987"
  warning-bg: "#3c3020"
  danger: "#ff958b"
  danger-bg: "#432427"
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

Graphite is a dark theme for Cairnboard. It changes colors and shadows only; shape, spacing, typography and motion
come from the root `DESIGN.md` and are the same in every theme. Token names match the root file one to one.

## Elevation & Depth

```yaml
shadow-box: 0 0 0 1px rgba(255, 255, 255, 0.05), 0 8px 24px rgba(0, 0, 0, 0.25)
shadow-box-raised: 0 0 0 1px rgba(255, 255, 255, 0.09), 0 18px 40px rgba(0, 0, 0, 0.45)
```
