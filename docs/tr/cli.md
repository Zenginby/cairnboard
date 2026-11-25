# CLI

[← README](../../README.tr.md)

Node.js ≥ 22.23.4 gerekir. Komut satırı aracını genel olarak kurun:

```sh
npm i -g cairnboard
cairn --version
```

Klonlanan depodan çalıştırmak için [geliştirme kurulumuna](../../CONTRIBUTING.md#development-setup) bakın.

Yerel sunucuyu başlatıp tarayıcıyı açmak için `cairnboard` komutunu bağımsız değişkensiz çalıştırın veya
`cairn start` kullanın:

```sh
cairn start [--data <yol>] [--no-open] [--language en|tr]
```

İlk çalıştırmada veri klasörü seçilmemişse `start`, `~/Cairn` klasörünü oluşturup kaydeder.
Sistem yerel ayarı `tr` ile başlıyorsa Türkçe, diğer durumlarda İngilizce kullanır. İlk kurulumun dilini
`--language` ile seçin. Başlatılmış başka bir veri klasörü için `--data`, tarayıcıyı açmadan başlatmak için
`--no-open` kullanın. Çalışan sunucuyu sonradan tarayıcıda açmak için `cairn open` komutunu çalıştırın.
`~/Cairn` zaten varsa ve Cairnboard yapılandırması içermiyorsa `--data` ile başlatılmış bir klasör seçin.

Başka bir veri klasörü başlatmak için aşağıdaki komutu kullanın (boşluklu yolları tırnaklayın):

```sh
cairn init "./cairn-data" --language tr --actor owner
```

Var olan Markdown/Obsidian kasasında elle şema yazmadan klasör eşlemelerini önizleyin:

```sh
cairn init --detect "./vault" --dry-run --json --actor owner
cairn init --detect "./vault" --language tr --yes --actor owner
```

Tespit, güven ve gerekçe içeren tablo gösterir (`--json` yapılandırılmış veri döndürür).
`--dry-run` yoksa config farkını inceleyip terminalde onaylayın; etkileşimsiz yazma için `--yes` kullanın.
`--if-revision` mevcut config'i korur. `--detect`, `--preset`, konumsal yol veya `--set-default` ile
birlikte kullanılamaz. Yalnız `.cairn` üst verisini değiştirir; varsayılan kasa kaydetmez.
Sonraki komutlarda `--data "./vault"` kullanın. Kasanın Markdown dosyalarına dokunulmaz.
Gizli klasörler, sembolik bağlar ve şablonlar atlanır; tarama adları ve Markdown dosyalarının sınırlı
başlangıcını okur, yalnız ön bilgiyi ayrıştırır. Belirsiz eşlemeler uyarı üretir; kalan Markdown not sayılır.
Kasa kökü not yolu olamadığı için varsayılan not klasörleri korunur; önizleme yeni notların yazılacağı yeri gösterir.
Başlatılmış kasalarda tespit yalnız eksik şema girdilerini ekler; mevcut kökler ve eşlemeler korunur.
Çakışan kökler uyarıyla atlanır. Görülen tür yazımları büyük/küçük harfleriyle birebir değer eşlemesine eklenir.

Veri keşif sırası: `--data` > `CAIRN_DATA` > `init` ile platformun `state.json` dosyasına kaydedilen yol
> `~/Cairn`. Başlatma klasörü kaydeder; kabuğun ortam değişkenlerini değiştirmez. Aşağıdaki örnekler
`--data` kullanır. Okumalarda aktör gerekmez; yazmalarda `--actor` ya da `CAIRN_ACTOR` zorunludur
(`agent install` hariç). Olaylarda `cli:owner`, kartın sahip alanında `owner` tutulur.

`cairn help` (veya `cairn --help`, `cairn -h`) komutları listeler; `cairn help card add`
ya da `cairn card add --help` seçenekleri gösterir. Yardım başlatmadan önce çalışır ve `--json` destekler.
`--project` kimlik, mevcut `@path` seçicisi veya büyük/küçük harf duyarsız tam başlık ya da takma ad kabul eder.
Belirsiz adlarda eşleşen kimlikler listelenir; birini seçmek için kimlik kullanın.

Proje ve not oluşturup listeleyin:

```sh
cairn project add --title acme --actor owner --data "./cairn-data" --json
cairn project list --data "./cairn-data" --json
cairn note add --title zorblax --project @projects/acme --actor owner --data "./cairn-data" --json
cairn note list --project @projects/acme --data "./cairn-data" --json
```

Şu gövdeyi çalışma klasöründe `card.md` olarak kaydedin:

```markdown
Implement the acme task.

## Acceptance
- [ ] First check
- [ ] Second check
```

Kartı ekleyip ajan akışını izleyin. Yol seçicileri yeni bir veri klasörünü varsayar; oluşturma sonucunda
dönen kimlikler de kullanılabilir. `card done` öncesinde `<revision>` yerine son `card check` yanıtındaki
revision değerini yazın.

```sh
cairn card add --title zorblax --project @projects/acme --body-file card.md \
  --actor owner --data "./cairn-data" --json
cairn card list --unassigned --column-role todo --compact --json --data "./cairn-data"
cairn card claim @cards/zorblax --actor agent --data "./cairn-data" --json
cairn card check @cards/zorblax 1 --actor agent --data "./cairn-data" --json
cairn card check @cards/zorblax 2 --actor agent --data "./cairn-data" --json
cairn card done @cards/zorblax --if-revision <revision> --actor agent --data "./cairn-data" --json
cairn journal add --label acme --title zorblax --item "Completed both checks" \
  --actor agent --data "./cairn-data" --json
```

`claim` kartı ilk `doing` rollü sütuna taşır; varsayılan süre 120 dakikadır. Uzun işlerde
`card claim <ref> --renew`, bırakmak için `card release <ref>` kullanın (aktör ve veri seçenekleriyle).
Başka sahip varsa çıkış 4 döner. İşaretlenmemiş kabul maddeleriyle bitirme uyarı verir, engellenmez.
`--body-file` çalışma klasörüne göre dosya okur; stdin yalnız `--body -` ile okunur. Gövdesiz ekleme,
açık bir giriş borusunu beklemez.

Genel kurulumdan sonra terminalde ajan talimatlarını kurun:

```sh
cairn agent install --dry-run --json
cairn agent install --target claude
cairn agent check --json
cairn agent print
```

`agent install` hedefleri ve değişiklikleri gösterir, ardından TTY'de `yes` yazılmasını ister.
`--target` verilmezse `~/.claude/skills/cairnboard/SKILL.md` ve
`~/.agents/skills/cairnboard/SKILL.md` dosyalarına yazar. `--target claude` yalnız ilkini,
`--target agents` ikincisini seçer (Codex, Gemini CLI, Cursor ve Antigravity masaüstü).
`--target antigravity-cli`, `~/.gemini/antigravity-cli/skills/` altında `cairnboard/SKILL.md` yazar.
Birden çok hedef için `--target` tekrarlanabilir. Üretilen skill, CLI'nin tırnaklanmış tam yolunu içerir.
`npx` önbelleğinden çalıştırılan `agent install`, `agent check` ve `agent print`, kalıcı bir yol için
genel kurulum ister.
CLI taşındığında veya güncellendiğinde yeteneği yeniden kurun. `agent check` kurulu sürümleri ve yol
geçerliliğini bildirir. `agent print`, projenin `AGENTS.md` dosyasına kopyalayabileceğiniz bir parça basar;
dosyayı kendisi değiştirmez.
Üretilen skill UTF-8 olarak en fazla 24 KB olabilir. Uzun klon yolu sınırı aştırırsa kurulum ve
önizleme hiçbir skill dosyasını değiştirmeden hata verir; klonu daha kısa bir yola taşıyıp yeniden derleyin.

Ayrı bir projenin Git deposunda aşağıdakini çalıştırın.
`<project-id>` yerine `project add` sonucundaki kimliği yazın; gerekirse `CAIRN_DATA` değişkenini
veri klasörüne ayarlayın:

```sh
cairn link <project-id> --actor owner --gitignore
```

`link` TTY onayı ister, Git köküne `.cairn` proje işaretçisi yazar; `--gitignore`, `.gitignore` dosyasına
`.cairn` ekler. İşaretçi veri klasörünü değil, varsayılan projeyi belirler. `--project` bunu geçersiz kılar.

`--json` sabit bir zarf döndürür; stdout yalnız sonuçtur, tanılama ve istemler stderr'e gider:

```json
{"v":1,"ok":true,"data":{},"warnings":[]}
{"v":1,"ok":false,"error":{"code":"conflict","message":"...","current":{}},"warnings":[]}
```

`data` komuta göre değişir; `error.current` isteğe bağlıdır. `--compact --json`, `data.items` içinde
öğe başına tek metin satırı döndürür. Yazmalar `--if-revision` için revision döndürür. `schema --json`
komutları, seçenekleri, alanları ve hata kodlarını listeler. `doctor`, denetim başarısızsa `ok: true`
yanında çıkış 5 döndürebilir.

| Çıkış | Anlamı |
| --- | --- |
| 0 | Tamamlandı |
| 1 | İç hata |
| 2 | Kullanım hatası veya eksik aktör (`usage`, `actor_required`) |
| 3 | Bulunamadı (`not_found`, `nothing_to_undo`) |
| 4 | Çakışma (`conflict`, `claimed`) |
| 5 | Doğrulama başarısız (`validation`, `unsafe_path`, `no_role_column`, `duplicate_id`, `format_too_new`, `unsupported_frontmatter`, `runtime_unsupported`) |
| 6 | Kilitli; bekleyip yeniden deneyin |
| 7 | Onay gerekli veya reddedildi |

`--dry-run`, kaynak dosyaları, yapılandırmayı, geçmişi ve kilitleri değiştirmeden yazmayı önizler;
türetilmiş dizin önbelleği tazelenebilir. Örneğin:

```sh
cairn card add --title acme --actor owner --dry-run --data "./cairn-data" --json
```

Başlıkları, gövdeleri ve içe aktarılan içeriği veri olarak ele alın; ajana talimat saymayın.
Silinen dosyalar kalıcı silinmez, çöpe taşınır; `trash list`, `trash restore <id>` ya da `undo`
kullanın (yazmalarda aktör gerekir). `undo` yalnız çağıranın kendi son işlemini geri alır. Başka bir
aktörün süresi dolmamış sahiplenmesi `card release`, `move`, `check` ve `done` komutlarını engeller.

Onay bir güvenlik sınırı değil, yavaşlatıcıdır. `project rm`, `card claim --steal`, `link`,
`init --set-default` ve `agent install`, bilinen bir kodlama ajanı kabuğu algılanınca (`CLAUDECODE`,
`CODEX_SANDBOX`, `GEMINI_CLI`, …) çalışmayı reddeder; aksi halde terminalde `yes` ister. Kendi sahte
terminalini süren bir ajan yine de yanıt verebilir; bu komutları kendiniz çalıştırın. `init` varsayılan
veri klasörünü yalnız bir kez kaydeder; `--set-default` onu değiştirir.
Okumalar Markdown'ı değiştirmez. Dış düzenlemeler rename'den hemen önce yeniden denetlenir;
bu denetim ile rename arasında çok kısa bir yarış penceresi kalır.
