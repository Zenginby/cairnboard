# Wiki

[← README](../../README.tr.md)

Pano ya da wiki işine `context` ile başlayın; sayfa özetleri ve bağlantı sayılarını `wiki index` ile okuyun:

```sh
node dist/cairn.mjs context --data "./cairn-data" --budget 1200 --json
node dist/cairn.mjs wiki index --data "./cairn-data" --json
node dist/cairn.mjs wiki index --format markdown --data "./cairn-data"
```

`note list` varsayılan olarak hızlı notları listeler; wiki sayfalarını katmak için `--all`, tür seçmek
için `--kind concept` ekleyin. `note show` giden bağlantıları ve geri bağlantıları da verir. Bağlam
paketinde uyanış, etkin projeler, kartlar, yakın tarihli kararlar, merkez sayfalar ve bekleyen iş
sayıları bulunur; `--project <ref>` kapsamı daraltır.

Mevcut Türkçe Obsidian kasasını başlatmadan ve dosyalarını değiştirmeden okuyabilirsiniz:

```sh
node dist/cairn.mjs context --data "./existing-vault" --preset tr-wiki --json
node dist/cairn.mjs wiki lint --data "./existing-vault" --preset tr-wiki --json
```

`tr-wiki`, Türkçe klasörleri ve `tur`, `etiketler`, `guncelleme` gibi alanları kanonik JSON anahtarlarına
eşler. Ham kaynakları ve yardımcı dosyaları wiki sayfalarına katmaz. Geçici okuma kipinde türetilen
dizin işletim sisteminin durum klasöründe durur; kasada `.cairn` oluşmaz. Yazma için başlatılmış veri
klasörü gerekir. Yeni bir Türkçe wiki oluşturmak için [CLI](cli.md) belgesindeki çağrıyla
`init "./new-wiki" --preset tr-wiki --language tr --actor owner` çalıştırın.

Önce yakala, sonra derle. Başlatılmış veri klasöründe UTF-8 `.md` ya da `.txt` kaynağını içe aktarın:

```sh
node dist/cairn.mjs ingest --title 'acme source' --file source.md --url https://example.com/source --actor agent --data "./cairn-data" --json
node dist/cairn.mjs ingest --title 'acme source' --body - --actor agent --data "./cairn-data" --dry-run --json
node dist/cairn.mjs search 'acme' --type raw --data "./cairn-data" --json
```

`--body -` stdin okur; kaynak metnini bir pipe ya da ajanın stdin arayüzüyle verin. Girdi en fazla
5 MB olabilir; ikili ya da geçersiz UTF-8 girdi reddedilir. `--url` yalnız kaynak adresini kaydeder,
içerik indirmez. Ingest, kaynak/tarih künyesinin arkasına özgün girdi baytlarını saklar ve aynı işlemde
işlenmemiş araştırma kaydı oluşturur. Aynı girdi baytları yeniden verilirse yeni dosya açmadan
`duplicate: true` döner. Dönen araştırma kaydına kısa özet yazın, yalnız doğrudan etkilenen sayfaları
güncelleyin; ayrıntılı sentezi ihtiyaç doğana bırakın. Ham kaynakları değiştirmeyin; düzeltmeleri ve
tarihli güncellemeleri wiki sayfasına yazın. İddiaları kaynağa dayandırın, çelişkileri `> [!WARNING]`
ile koruyun; değişen bilgide önceki değeri tarihli üstü çizili metinle ya da `valid_from` / `valid_until`
ve `superseded_by` alanlarıyla saklayın.

`note add` ve `note update`, birlikte kullanılamayan `--pin` ve `--unpin` seçeneklerini destekler.
Not ve araştırma ekleme/güncelleme komutları geçerlilik ve yerine geçen kayıt için
`--valid-from YYYY-MM-DD`, `--valid-until YYYY-MM-DD` ve `--superseded-by <ref>` kabul eder.
`research add` ve `research update` ayrıca isteğe bağlı,
serbest, tek satırlık ve en çok 100 karakterlik `--category '<metin>'` seçeneğini kabul eder (güncellemede
boş değer alanı siler; tr-wiki düzeni bunu `kategori` olarak saklar).

Özet ve doğrudan etkilenen sayfalar kaydedilince `research show <research-id>` ile araştırmanın güncel
revision değerini okuyup işlenmiş olarak işaretleyin. Yer tutucular yerine kaydın kimliğini (ya da yol
seçicisini) ve revision değerini yazın; özet güncellemesi ingest sonucundaki revision değerini değiştirir.

```sh
node dist/cairn.mjs research update <research-id> --processed --if-revision <revision> \
  --actor agent --data "./cairn-data" --json
```

Eksik kalan kaynakları işlenmemiş bırakın. Bu adım tamamlanan kaynağı lint'in `unprocessed_source`
bulgularından ve bağlam paketinin bekleyen sayısından çıkarır; ayrıntılı sentez yine sonraya kalabilir.

Sayfayı kaydetmeden önce tam taslağını stdin üzerinden, veri klasörüne göre hedef yoluyla denetleyin:

```sh
node dist/cairn.mjs wiki check - --path wiki/concepts/acme.md --data "./cairn-data" --json
node dist/cairn.mjs wiki lint --verify --evidence --code --data "./cairn-data" --json
```

`wiki check` taslağı kaydetmez; hata varsa çıkış 5 döner. `required`, `sources`, `links`, `filename`
kuralları `config.rules` ciddiyetlerini kullanır; zorunlu alanlar, kaynaklar ve bağlantılar varsayılan
olarak uyarıdır. `wiki lint` dosyaları onarmadan raporlar; `--strict` hata ya da uyarıda çıkış 5 döndürür.
`--verify` ham kaynak özetlerini yeniden hesaplar, `--evidence` alıntı ve sayıları yerel ham metinle
karşılaştırır, `--code` bağlanmış projede referans verilen kodun değişmesini denetler. Kanıt denetimi
bir iddianın doğru olduğunu kanıtlamaz. Bulguları inceleyip düzeltmeleri onayladıktan sonra ajana
uygulatın. Günlükte sıradan `--item` yerine `--decision`, `--discovery`, `--pitfall`, `--lesson` ile
karar, keşif, tuzak ve ders kaydedebilirsiniz.

`mentions`, bir notun adını (başlık, dosya adı ya da takma ad; Türkçe büyük/küçük harf katlamasıyla)
geçirip ona bağlantı vermeyen sayfaları listeler; kod, var olan wiki bağlantıları ve nota zaten bağlantı
veren sayfalar atlanır. Kesme işaretinden sonraki ek anma sayılır (`Acme'de`), bitişik ek sayılmaz.
`--link <yol>:<satır>` o satırdaki tek anmayı onayınızdan sonra wiki bağlantısına çevirir; `undo` geri alır.

```sh
node dist/cairn.mjs mentions @notes/acme --data "./cairn-data" --json
node dist/cairn.mjs mentions @notes/acme --link notes/board.md:12 --actor owner --data "./cairn-data"
```

İsteğe bağlı Claude Code Write/Edit kancasını kendiniz bir terminalden kurabilirsiniz:

```sh
node dist/cairn.mjs agent install --target claude --hooks --dry-run --json
node dist/cairn.mjs agent install --target claude --hooks
node dist/cairn.mjs agent check --json
node dist/cairn.mjs doctor --data "./cairn-data" --json
```

Kurulum ayar farkını gösterir, onay ister, başka kancaları korur ve mevcut ayarları atomik olarak
değiştirmeden önce yedekler. `CLAUDE_CONFIG_DIR` varsa `~/.claude` yerine onu kullanır. Kanca normal
veri keşfini (`CAIRN_DATA` ya da kayıtlı varsayılan) kullanır; başlatılmamış kasa için çağrıda açıkça
`--data` ve `--preset` gerekir. Önerilen sayfa metnini ayarlı kurallarla denetler; hataları engeller,
uyarıları ajanın bağlamına verir. Veri bulunamazsa, düzenleme belirsizse ya da beklenmedik girdi
gelirse izin verir; bu yüzden taslak denetimini de kullanın. Kapsam Claude Code Write/Edit'tir;
kabukla yazma ve diğer ajanlar kapsam dışındadır. Ayrıntı: [Claude Code kanca protokolü](https://code.claude.com/docs/en/hooks).
