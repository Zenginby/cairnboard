---
version: alpha
name: Cairnboard Graphite
description: Cairnboard Graphite theme (light). Same token names as every other theme.
colors:
  canvas: "#e9ebef"
  surface: "#f8f9fb"
  surface-inset: "#f0f2f5"
  surface-inset-2: "#e3e6eb"
  line: "rgba(20, 30, 50, 0.1)"
  line-strong: "rgba(20, 30, 50, 0.18)"
  material: "rgba(233, 235, 239, 0.75)"
  pill-bg: "#dcdfe5"
  pill-indicator: "#f8f9fb"
  text: "#1b1e24"
  text-2: "#3f4550"
  text-3: "#5b6270"
  link: "#2c5aa8"
  focus: "#3563b8"
  focus-bg: "#e0e8f6"
  on-accent: "#ffffff"
  primary: "#3563b8"
  tone-1: "#6e6af0"
  tone-1-text: "#4a45c9"
  tone-1-bg: "#eceaf9"
  tone-2: "#1fa98f"
  tone-2-text: "#0b6b5a"
  tone-2-bg: "#e0f2ee"
  tone-3: "#f0a030"
  tone-3-text: "#8a4800"
  tone-3-bg: "#f9edda"
  tone-4: "#1c9bd1"
  tone-4-text: "#0b5f86"
  tone-4-bg: "#dfeef6"
  tone-5: "#d4508f"
  tone-5-text: "#962360"
  tone-5-bg: "#f8e5ee"
  tone-6: "#e5603a"
  tone-6-text: "#9e321a"
  tone-6-bg: "#f9e6df"
  tone-7: "#3c9a4a"
  tone-7-text: "#22682d"
  tone-7-bg: "#e2efe4"
  tone-8: "#7a7f8e"
  tone-8-text: "#454c64"
  tone-8-bg: "#e4e7ee"
  done: "#196f3d"
  done-bg: "#e0efe4"
  doing: "#2c5aa8"
  doing-bg: "#e0e8f6"
  planned: "#565c68"
  planned-bg: "#e3e6eb"
  urgent: "#ab241c"
  urgent-bg: "#f8e1de"
  important: "#7f5000"
  important-bg: "#f8edc8"
  warning: "#895600"
  warning-bg: "#f8ecd7"
  danger: "#ab241c"
  danger-bg: "#f6e3e1"
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

Graphite is a light theme for Cairnboard. It changes colors and shadows only; shape, spacing, typography and motion
come from the root `DESIGN.md` and are the same in every theme. Token names match the root file one to one.

## Elevation & Depth

```yaml
shadow-box: 0 1px 2px rgba(20, 30, 50, 0.05), 0 8px 24px rgba(20, 30, 50, 0.07)
shadow-box-raised: 0 2px 4px rgba(20, 30, 50, 0.06), 0 18px 40px rgba(20, 30, 50, 0.12)
```
