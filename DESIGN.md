---
version: alpha
name: Cairnboard Bento
description: Cairnboard Bento theme (light). Same token names as every other theme.
colors:
  canvas: "#f2f2f5"
  surface: "#ffffff"
  surface-inset: "#f5f5f8"
  surface-inset-2: "#ebebf0"
  line: "rgba(16, 16, 30, 0.09)"
  line-strong: "rgba(16, 16, 30, 0.16)"
  material: "rgba(242, 242, 245, 0.72)"
  pill-bg: "#e1e1e5"
  pill-indicator: "#ffffff"
  text: "#1d1d1f"
  text-2: "#45454c"
  text-3: "#64646c"
  link: "#0060c0"
  focus: "#0071e3"
  focus-bg: "#e4effc"
  on-accent: "#ffffff"
  primary: "#0071e3"
  tone-1: "#6e6af0"
  tone-1-text: "#4a45c9"
  tone-1-bg: "#eeedfd"
  tone-2: "#1fa98f"
  tone-2-text: "#0b6b5a"
  tone-2-bg: "#e2f5f0"
  tone-3: "#f0a030"
  tone-3-text: "#8f4c00"
  tone-3-bg: "#fdf0dc"
  tone-4: "#1c9bd1"
  tone-4-text: "#0b5f86"
  tone-4-bg: "#e1f2fb"
  tone-5: "#c45aa8"
  tone-5-text: "#8a3a7a"
  tone-5-bg: "#f8e7f3"
  tone-6: "#d95060"
  tone-6-text: "#a3343f"
  tone-6-bg: "#fce8ea"
  tone-7: "#7a7f8e"
  tone-7-text: "#48506a"
  tone-7-bg: "#e8ebf3"
  tone-8: "#3c9a4a"
  tone-8-text: "#226b2e"
  tone-8-bg: "#e4f3e6"
  done: "#1a7340"
  done-bg: "#e3f4e9"
  doing: "#0060c0"
  doing-bg: "#e4effc"
  planned: "#5c5c66"
  planned-bg: "#ececf1"
  urgent: "#b3261e"
  urgent-bg: "#fde4e1"
  important: "#855400"
  important-bg: "#fff1c7"
  warning: "#8f5a00"
  warning-bg: "#fdf0dc"
  danger: "#b3261e"
  danger-bg: "#fce8e6"
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
# Cairnboard

## Overview

Cairnboard's look is called **Bento**: a light grey canvas, white boxes with large rounded corners, one soft tone per
project and Inter for all text. Chrome around the content is quiet (low-contrast lines and pills); content itself is
high-contrast and easy to read. Boxes are used on overview screens (home, projects, project cover); document pages
are plain surfaces with no box inside a box.

Themes: a theme is a family with a light and a dark palette. This file is the light palette of the default family,
Bento. Every other palette lives in `design/themes/<family>.md` (light) or `design/themes/<family>-dark.md` (dark)
with exactly the same color token names and is linted on its own. Families: `bento`, `paper` (warm) and `graphite`
(cool grey). The page picks a family with `data-theme` and a mode with `data-mode` (`light`, `dark`, or absent to
follow the system). A theme changes colors and shadows only. Shape, spacing, typography and motion are defined here
and nowhere else.

## Colors

Neutral surfaces step from `canvas` (page) to `surface` (box) to `surface-inset` and `surface-inset-2` (wells inside a
box). Text has three levels: `text`, `text-2` for secondary copy, `text-3` for metadata. `focus` is the single accent:
links, the focus ring, the primary button and the selected state. Projects get one of eight tones (`tone-1` … `tone-8`),
each with a drawing color, a text color (`-text`) and a soft fill (`-bg`); tones are assigned by project order and
never carry meaning on their own. Status colors (`done`, `doing`, `planned`, `urgent`, `important`, `warning`,
`danger`) are always shown with a word, never by color alone.

## Copy

- Address the reader as "sen" in Turkish, including accessible labels.
- Use a verb and an explicit object for action buttons ("Kartı ekle", "Notu kaydet").
- Write empty, loading and error messages for the specific screen; give one clear next action.
- State what the screen knows; avoid slogans and promotional copy.
- Use varied, plausible fictional data; never use "örnek", "demo" or "acme" as sample content.

## Typography

Inter Variable for everything except code. Body text is 16px with a 1.7 line height; labels are 13px and slightly
heavier. Headings use tighter letter spacing. Numbers in tables and counters use tabular figures.

## Layout

A 16px base gap between boxes; 24px padding inside large boxes and 16px inside small ones. Content width for prose is
46rem. At 375px the side gutter is 16px and nothing scrolls horizontally except the board.

## Elevation & Depth

Boxes sit on the canvas with a very soft two-layer shadow; a hovered or lifted box uses the raised shadow. In dark
themes the shadow becomes a 1px light outline.

```yaml
shadow-box: 0 1px 2px rgba(16, 16, 30, 0.04), 0 8px 24px rgba(16, 16, 30, 0.06)
shadow-box-raised: 0 2px 4px rgba(16, 16, 30, 0.05), 0 18px 40px rgba(16, 16, 30, 0.1)
shadow-indicator: 0 1px 3px rgba(0, 0, 0, 0.12)
```

## Shapes

`lg` (28px) for hero boxes, `md` (20px) for regular boxes and cards, `sm` (12px) for inputs, menus and small cards,
`full` for pills and badges.

## Motion

Motion explains where something came from or confirms that an action happened; it is never decoration. Only
`transform` and `opacity` animate, with three exceptions the Bento look depends on: a box's shadow changes with
`ease-default` while it lifts on hover (`distance-lift`, `distance-lift-card`, `scale-hover`), a collapsing column
animates `grid-template-rows` from `0fr` to `1fr` with a short `blur-small` fade, and the header material uses
`blur-material` and `saturate-material` as a static backdrop filter. Every animation can be interrupted (transitions, not keyframes, for state changes).
Closing is one step shorter than opening and uses `ease-out`. Things opened by keyboard shortcut appear without
animation. Stagger is used only on first load, at most `stagger-max-items` items. With `prefers-reduced-motion:
reduce` or the "Motion: less" setting, movement is removed and only short fades remain. `ease-spring` and `ease-spring-bouncy`
fall back to `ease-spring-fallback` where `linear()` is not supported. Page changes are plain: content swaps instantly;
only the tab pill slides and a home box may grow into its page title. Never give long content a view-transition name.
Theme changes reveal the new palette as a circle growing from the control that changed it (a view transition on
the root, `clip-path` from radius 0 to the farthest corner, `duration-theme-reveal` with `ease-out-quart`); this is
the one animation that is not `transform` or `opacity`. During it nothing else transitions, and without view
transition support, with reduced motion or with "Motion: less" the theme changes instantly.

```yaml
duration-stagger: 40ms
duration-press: 120ms
duration-quick: 150ms
duration-fast: 250ms
duration-medium: 350ms
duration-slow: 400ms
duration-very-slow: 500ms
duration-highlight: 700ms
duration-theme-reveal: 800ms
duration-pulse: 2400ms
stagger-max-items: 5
ease-smooth-out: cubic-bezier(0.22, 1, 0.36, 1)
ease-out: ease-out
ease-in-out: ease-in-out
ease-default: ease
ease-settle: cubic-bezier(0.15, 1, 0.3, 1)
ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1)
ease-spring: linear(0, 0.038, 0.125, 0.233, 0.345, 0.451, 0.547, 0.63, 0.701, 0.76, 0.809, 0.849, 0.881, 0.906, 0.927, 0.943, 0.956, 0.966, 0.973, 0.979, 0.984, 0.988, 0.991, 0.993, 1)
ease-spring-bouncy: linear(0, 0.051, 0.17, 0.319, 0.471, 0.611, 0.73, 0.826, 0.899, 0.952, 0.988, 1.01, 1.023, 1.028, 1.028, 1.026, 1.022, 1.018, 1.013, 1.01, 1.007, 1.004, 1.002, 1.001, 1)
ease-spring-fallback: cubic-bezier(0.22, 1, 0.36, 1)
distance-lift-card: 2px
distance-lift: 3px
distance-micro: 4px
distance-base: 8px
distance-medium: 12px
scale-press: 0.97
scale-press-box: 0.98
scale-hover: 1.012
scale-enter: 0.96
blur-small: 2px
blur-medium: 3px
blur-large: 8px
blur-material: 20px
saturate-material: 180%
```

Drag and drop on the board: the card's old place drops to 40% opacity, a 2px line marks the drop point, the dropped
card settles with FLIP over `duration-fast` and `ease-settle`, then its background glows for `duration-highlight`.
Every card also has a "Move…" menu (WCAG 2.5.7), and each move is announced in one persistent `aria-live` region.

## Components

Boxes (`box`), wells (`inset`), pills, badges, the primary button, tone chips and status chips are defined in the
front matter so their contrast is checked in every theme.

## Do's and Don'ts

- Do read colors, spacing, radii, durations and easings only from `tokens.css`; add a token here before using a new value.
- Do show status with a word as well as a color.
- Don't put text on a translucent color; use an opaque token (the contrast lint cannot composite alpha).
- Do keep focus rings visible: 2px ring, 2px offset, at least 3:1 against the surface.
- Don't animate layout properties (width, height, top, left) or start anything from `scale(0)`.
- Don't put a box inside a box on document pages.
- Don't add theme-specific shapes or motion; a theme is colors and shadows only.
