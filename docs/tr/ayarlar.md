# Ayarlar

[← README](../../README.tr.md)

Sahip web arayüzündeki `/settings` sayfasından ya da `cairn config` komutuyla dört isteğe bağlı özelliği açıp
kapatabilir. `.cairn/config.json` içinde yazılmayan özellik varsayılan olarak açık sayılır:

- **Değişiklik izi (`change-trail` / `changeTrail`)**: dış Markdown düzenlemelerini (kim, ne zaman, hangi dosya)
  kaydeder. Kapatılınca uzlaştırma durur; yeniden açılınca sahte dosya olayları yerine `.cairn/shadow` yeniden taban
  alır ve tek bir `external.gap` olayı yazılır. Kendi yazmaları ve `undo` geçmişi etkilenmez.
- **Ne değişti (`change-content` / `changeContent`)**: `changes --diff` ile farkları gösterebilmek için `.cairn/shadow`
  içinde önceki içerik kopyalarını saklar. Kapatılınca yalnız revizyonlar tutulur (`content_not_kept`).
  `change-trail` kapalıyken etkisizdir.
- **Canlı güncelleme (`live-updates` / `liveUpdates`)**: dosyalar değişince açık web sayfalarını `/api/events`
  üzerinden yeniler. Kapalıyken `/api/events` 404 döner ve sayfalar elle yenilenir; sunucu izleyicisi dizini ve
  açıksa değişiklik izini güncellemeyi sürdürür.
- **Bağlantısız anmalar (`mentions`)**: bağlantısız not anmalarını bulur ve bağlar. Kapalıyken `mentions`
  `feature_disabled` hatası verir, `help` komutu `(disabled)` gösterir ve `agent install` ajanın skill belgesinden
  çıkarır. Önceki bağlantılara dokunulmaz.

Ayarları herhangi bir terminalden okuyabilir, kendi etkileşimli terminalinizden ya da `/settings` sayfasından
değiştirebilir ve iz revizyonlarını koruyarak saklanan içerik kopyalarını temizleyebilirsiniz:

```sh
node dist/cairn.mjs config --data "./cairn-data" --json
node dist/cairn.mjs config get change-trail --data "./cairn-data"
node dist/cairn.mjs config set change-content off --data "./cairn-data"
node dist/cairn.mjs config clear-shadow --data "./cairn-data"
```

`config set <özellik> on|off` ve `config clear-shadow` yalnız sahibin kendi etkileşimli terminalinde çalışır (`--yes`
yoktur): TTY olmayan akışlarda veya bilinen bir kodlama ajanı kabuğunda `owner_only` hatası verir. Onay için
özellik adını (`clear-shadow` için `clear`) yazmanız istenir; `--actor` verilmezse `owner` (`cli:owner`) kullanılır.
`cairn context`, ajanı etkileyen kapalı özellikleri `settings` bölümünde açıkça listeler.

Ayarlar yalnız sahip içindir, ancak CLI sahipliği kriptografik bir sınır değildir: `--actor` serbest yazıdır, kendi
sahte terminalini süren bir araç yanıt verebilir ve `.cairn/config.json` diskte doğrudan düzenlenebilir. Amaç sessiz
değişiklik olmamasıdır: yazmalar terminal onayı ya da korumalı `/settings` POST isteği gerektirir, değişiklikler
`config.change` (temizleme `shadow.clear`) yazar, `features` alanındaki elle düzenlemeler `config.external`
(`owner:external`) olarak kaydedilir ve kapalı özellikler `context` çıktısında görünür.
