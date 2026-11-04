# Trash (Çöp)

Deleted items, each with a way to put it back. Preview: `http://127.0.0.1:4391/prototypes/trash/`.

- **Reproduces:** the original's card table style: a rounded table with an inset header row and hairline rows, on the document-frame (white) page with the board's title row. A blue info note says that nothing is ever deleted permanently from here.
- **Rows:** a checkbox, a kind badge with the title, the project with its tone dot, when it was deleted (Bugün or Dün with the time, otherwise the date) and who deleted it. A person shows as an initial avatar and a name. An agent shows as a monospace badge with the word "ajan". Every row has its own Geri yükle button. Below 56rem each row becomes a labelled stack.
- **Selection:** Tümünü seç supports the mixed state. "Seçilenleri geri yükle (n)" restores all selected rows. Restored rows fade and slide out over `duration-quick`. Focus moves to the next row's button. A green status line and a live announcement confirm where the items went.
- **States:** dolu, boş, yükleniyor, hata, kilitli (a card cannot be restored while claude works on its board; its row is disabled and explains why), 409 çakışma (the item was already restored in another session: Yeniden yükle and Farkı gör) and uzun metin.
- **Keyboard:** Tab, Space and Enter in native order, plus the shared shortcuts. The table uses ARIA table roles.
- **Known limits:** restore only removes the row in this prototype. There is no undo after a restore, and no sort or filter.
