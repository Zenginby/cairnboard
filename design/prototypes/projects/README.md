# Projects (Projeler)

All projects in three sections, Aktif, Beklemede and Arşiv. Each section is a six-track grid of project boxes. Preview: `npm run design:serve`, then `http://127.0.0.1:4391/prototypes/projects/`.

- **Reproduces:** the original's projects list (three status groups, each with a 24px section heading over a six-track grid that drops to two tracks at 64rem and one at 40rem) and its project box: a tone wash at the top of the box, the title with a short description and note count, the 64px progress ring, a large "13/15 kart" figure in the tone's text colour, and a focus line clamped to three lines. The box markup and CSS match the home page's project boxes, so a box looks the same on both pages.
- **Page title:** a board-style title row. "Projeler" and a count ("8 proje · 4 aktif") sit on the left, and the primary "Proje ekle" pill sits on the right.
- **Proje ekle:** the shared editor dialog with the fields Ad (required, must be unique, with an inline error), Kısa açıklama, and Ton, which shows the eight tones as round radio swatches. Each swatch has a text label for screen readers. The first unused tone is selected. A new project goes into Aktif, fades and rises in, gets focus and is announced.
- **Data:** `../_shared/workspace.json`, the same fixture as home, through `loadData`. `data.json` holds the group of each project and the tone names. Every box links to `../project/?project=…`.
- **Motion:** first-load stagger of up to five boxes, the ring reveal in two halves, the hover lift (3px, scale 1.012, raised shadow with `ease-default`) and a 0.98 press. All of it is copied from home. Swatch selection uses a small spring scale. Reduced motion and "Hareket: az" keep only opacity fades.
- **Keyboard:** `P` opens Proje ekle. The shared shortcuts also work: `N`, `C`, `/`, `⌘K` or `Ctrl+K`, and `?`. Tab and Space work in the dialog, and arrow keys move between tone swatches.
- **States:** dolu, boş (own text and a "Proje ekle" action), yükleniyor, hata, kilitli ("Proje ekle" is disabled and a lock message explains why), 409 çakışma (projects.yml changed outside: Yeniden yükle and Farkı gör) and uzun metin.
- **Known limits:** you cannot change a project's status from this page. Archived projects get the same box as active ones; the original only dims them through its section.
