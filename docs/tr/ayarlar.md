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

## Dil

`language` (`en` ya da `tr`) veri klasörünün arayüz dilidir; değer yoksa arayüz İngilizce açılır. Yalnız arayüzü
etkilemez: günlük bölüm etiketleri, Türkçe yazım kuralları ve wiki sıralaması da bu değeri izler. Pano sütun adları
sizin verinizdir, çevrilmez.

- **Web**: `/settings` sayfasındaki Dil bölümünden English ya da Türkçe seçip kaydedin. Çalışan sunucu aynı süreçte
  dil değiştirir; sonraki sayfa (hata sayfaları dahil) yeni dildedir, yeniden başlatma gerekmez.
- **CLI**: `config get language` kodu yazar, `config set language tr|en` değiştirir; özelliklerle aynı yalnız-sahip
  kuralı geçerlidir (onay için `language` yazılır). `config --json` çıktısında `language` bulunur.
- CLI değişikliği ya da elle düzenleme sonrasında arayüz önceki dilde kalır. Yeni dili görmek için sunucuyu yeniden
  başlatın ya da dili `/settings` sayfasında kaydedin.

## Pano

`/settings` sayfasındaki Pano bölümünde bir sütunun adını kaydedebilir, sütunu gizleyip gösterebilir veya bir basamak
yukarı ya da aşağı taşıyabilirsiniz. Her işlem ayrı kaydedilir. Sütun adı boş olamaz ve en çok 40 karakter olabilir.
Yalnız büyük-küçük harf ya da noktalı ve noktasız i farkıyla ayrılan adlar aynı sayılır. Her rolün ilk sütunu görünür
kalır. Sütun anahtarları ve rolleri değişmez.

Gizli sütunlar ve kartları arşivde görünür. Son gizli sütunu gösterdiğinizde arşiv panodan kalkar. Sütun sırası yeni,
sahiplenilen, bitirilen ve arşivden geri alınan kartların hedefini belirler. Şeritler rol sırasını korur. Sıra değişince
mevcut kartlar kendi sütunlarında kalır.

Sahiplenme süresini 5 ile 1440 arasında tam dakika olarak ayarlayabilirsiniz. Yeni süre sonraki sahiplenmeler ve
yenilemeler için geçerlidir. Sayfa açıkken ayarlar başka yerden değişirse Ayarlar'ı yeniden açıp işlemi güncel
değerlerle tekrarlayın.

Aynı ayarlara terminalden de ulaşabilirsiniz.

- `cairn config get columns` sütun anahtarlarını, adlarını, rollerini ve gizli olup olmadıklarını sırayla listeler.
- `cairn config set column.<key>.label "Yeni ad"` bir sütunun adını değiştirir.
- `cairn config set column.<key>.hidden on|off` bir sütunu gizler ya da gösterir.
- `cairn config set columns-order <key1>,<key2>,...` sütun sırasını belirler. Her anahtarı tam bir kez yazın.
- `cairn config get lease-minutes` süreyi okur, `cairn config set lease-minutes <minutes>` değiştirir.

## Komutlar

Ayarları herhangi bir terminalden okuyabilir, kendi etkileşimli terminalinizden ya da `/settings` sayfasından
değiştirebilir ve iz revizyonlarını koruyarak saklanan içerik kopyalarını temizleyebilirsiniz:

```sh
node dist/cairn.mjs config --data "./cairn-data" --json
node dist/cairn.mjs config get change-trail --data "./cairn-data"
node dist/cairn.mjs config set change-content off --data "./cairn-data"
node dist/cairn.mjs config get language --data "./cairn-data"
node dist/cairn.mjs config set language tr --data "./cairn-data"
node dist/cairn.mjs config clear-shadow --data "./cairn-data"
```

`config set` ve `config clear-shadow` ile yazmak için sahibin kendi etkileşimli terminali ve yazılı onayı gerekir.
TTY olmayan akışlarda veya bilinen bir kodlama ajanı kabuğunda `owner_only` hatası verilir. `config set` için ayarın
adını (örneğin `language` ya da `lease-minutes`), `config clear-shadow` için `clear` yazın. `--actor` verilmezse `owner`
(`cli:owner`) kullanılır. `cairn context`, ajanı etkileyen kapalı özellikleri `settings` bölümünde listeler.

Ayarlar yalnız sahip içindir, ancak CLI sahipliği kriptografik bir sınır değildir: `--actor` serbest yazıdır, kendi
sahte terminalini süren bir araç yanıt verebilir ve `.cairn/config.json` diskte doğrudan düzenlenebilir.

## Ayar olayları

- Dil ve pano ayarlarını web veya CLI üzerinden, ana sayfadaki proje görünürlüğünü web üzerinden değiştirmek
  `config.change` olayı yazar. Olayın `fields` dizisi yalnız değişen alan adlarını taşır. Özellik açma ve kapatma
  işlemleri de `config.change` yazar ve `feature`, `before`, `after` alanlarını kullanır. `config.language` ve
  `config.home` olay adları artık kullanılmaz.
- `features`, `language`, `home.hiddenProjects`, `leaseMinutes` ve sütun adı, görünürlüğü veya sırasındaki elle
  düzenlemeler algılandığında `owner:external` aktörüyle `config.external` yazılır. Özellik değişiklikleri `changed`
  ve `after`, diğer izlenen ayarlar `fields` ile kaydedilir. Sütun alanları `columns.label`, `columns.hidden` ve
  `columns.order` adlarını kullanır. Elle sütun eklemek ya da silmek kaydedilen sütun sırasını değiştirir. Sürüm
  değişmiş ve önceki alan özetleri bulunamıyorsa `unknown: true` listelenen alanların değişmiş olabileceğini belirtir.
- Gölge deposunu temizlemek `shadow.clear` olayı yazar.
