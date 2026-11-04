# 404 (Sayfa bulunamadı)

Preview: `http://127.0.0.1:4391/prototypes/not-found/`.

- **Shows:** one Bento card with a big "404", one sentence and an "Ana sayfaya dön" primary button. An Ara button opens the top bar's search dialog. Below the card, "Belki bunlardan biri" lists a few recent notes. The page keeps the normal top bar with no tab selected; the tab indicator is hidden and stays still.
- **Reproduces:** the original had no designed error page. This page uses the home hero's type scale (hero number, display sentence, lead text) and the home list-row style for the suggestions.
- **States:** the card is always visible, and the states change only the suggestions. dolu shows the notes, boş hides the section, yükleniyor shows skeletons, hata says the suggestions could not load, and uzun metin lengthens the text. The page does not show the requested path.
- **Motion:** the card and the suggestions rise in once with a stagger. Rows nudge 4px on hover. Reduced motion keeps only the fades.
- **Keyboard:** the skip link, the buttons and links in order, and the shared shortcuts (`/`, `⌘K`).
