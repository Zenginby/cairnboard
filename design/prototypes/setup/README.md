# First run (İlk açılış)

A centred four-step flow shown before a workspace exists. Preview: `http://127.0.0.1:4391/prototypes/setup/`.

- **Reproduces:** the Bento look of the home hero (large hero-type heading, lead text, a 28px-radius card on the canvas). The top bar shows the logo only, with no tabs, search or theme controls. The original had no first-run screen. The pinned-notes rail is deliberately left out, because no notes exist before setup.
- **Steps:** 1) Hoş geldin with a Türkçe or English choice. 2) Veri klasörü, a path field with a simulated server check. The answer is Geçerli, Yok with an "Oluşturulsun mu?" Oluştur button, or İzin yok. Devam is enabled only for a valid folder. 3) Örnek veri ekle, optional. 4) Hazır, with a summary and "Ana sayfaya git" to `../home/`. A step indicator above the card marks the current step with `aria-current="step"`.
- **Server check (prototype):** a path containing "izin", or starting with `/sistem`, `/system` or `/root`, gets İzin yok. A path containing "yeni" or "yok" gets Yok. Anything else is Geçerli. The check runs on Denetle, on Enter or on change, and the result is announced.
- **Motion:** each step change slides the card 12px in the direction of travel and fades it (`duration-fast`, `ease-smooth-out`). Reduced motion keeps only the fade. Focus moves to the step heading.
- **States:** dolu, boş (step 2 with an empty field), yükleniyor (server starting), hata (server unreachable, retry), klasör yok, izin yok and uzun metin (long path and lead).
- **Known limits:** no folder picker, because browsers cannot open one for a local server path. Nothing is created on disk.
