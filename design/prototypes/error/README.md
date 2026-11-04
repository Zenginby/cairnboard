# 500 (Bir şey ters gitti)

Preview: `http://127.0.0.1:4391/prototypes/error/`.

- **Shows:** one Bento card with a big "500" in the danger colour. One sentence says that no files changed, followed by "Ana sayfaya dön" and "Yeniden dene". The only detail shown is a short reference code with a time. The page never shows a path, a file name or a stack trace.
- **Reproduces:** the same status-card layout as `not-found/`, which uses the home hero's type scale.
- **States:** dolu; boş (no reference code); yükleniyor (Yeniden dene is busy with a spinner); hata (the retry failed again, with a hint to run `cairn doctor`); uzun metin. Pressing Yeniden dene in the prototype always ends in the hata state and announces it.
- **Motion:** the card rises in once, and the spinner is the shared one. Reduced motion keeps only the fade and stops the spinner.
- **Keyboard:** native order, and focus returns to Yeniden dene after a failed retry.
