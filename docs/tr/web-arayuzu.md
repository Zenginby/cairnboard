# Web arayüzü

[← README](../../README.tr.md)

Arayüz, veri klasörünün `language` değerini kullanır (`en` ya da `tr`, `init --language` ile seçilir); değer yoksa
İngilizce açılır. Dili `/settings` sayfasındaki Dil bölümünden değiştirin: çalışan sunucu hemen geçer. CLI ile ya da
elle değiştirdikten sonra sunucuyu yeniden başlatın ya da dili `/settings` sayfasında bir kez kaydedin
([Ayarlar](ayarlar.md)).

`npm start` web arayüzünü derler, sunucuyu başlatır ve tarayıcıyı açar. Sunucu 4321–4340 aralığındaki
ilk boş portu kullanır ve yalnızca geri döngüde (`127.0.0.1` ve `::1`) dinler. Çalışan arayüzü yeniden açmak için
`cairn open` kullanın.

Arayüz `http://<26 harf>.cairnboard.localhost:4321/` gibi size özel bir adreste açılır. Harfler anahtarınızdan
türetilir: bu makinede hep aynıdır, başkası tahmin edemez; `*.localhost` her zaman kendi makinenizi gösterir. Başka
adresler (`127.0.0.1`, `localhost`) reddedilir. Tarayıcılar çerezi bir adın bütün portlarında paylaştığı için sabit
bir ad, aynı makinedeki başka bir hesabın başka porttaki bir sayfayla çerezi toplamasına izin verirdi.

Okumalar dahil her sayfa oturum çerezi ister. `npm start` ve `cairn open` tarayıcıyı 60 saniye geçerli, tek
kullanımlık bir bağlantıyla açar; çerez sonra 30 gün geçerlidir ve sunucu yeniden başlasa da kalır. Çerezi
olmayan tarayıcı `cairn open` çalıştırmanızı isteyen bir sayfa görür. Anahtar veri klasöründe değil, kullanıcının
durum klasöründe tutulur.

Oturum çereziyle korunan okuma API’si `/api/home`, `/api/board`, `/api/cards/:id` ve `/api/notes/:id` yollarında
yalnız GET sunar (HEAD de desteklenir).

**Ajan panosu.** Ajan işlerini bir projede toplayın ve `.cairn/config.json` dosyasına
`"agents": { "project": "<proje-kimliği>" }` olarak yazın. Bu projenin kartları ana panodan ve Ana sayfadan çıkar,
`/agents` sayfasında (aramanın yanındaki robot düğmesi) görünür; Ana sayfa her sütunda kaç iş olduğunu gösterir.
`"hidden": true` taşıyan sütun (örneğin `{ "key": "archive", "label": "Arşiv", "role": "done", "hidden": true }`) iki
panoda da görünmez: incelenen ajan kartlarını oraya taşıyın, panonun Arşiv bağlantısından açın. CLI ve API bütün
sütunları ve kartları listelemeyi sürdürür.

**Araçlar (isteğe bağlı).** Cairnboard makinenizi taramaz. Kendi tarayıcınız her makine için bir görüntüyü
`.cairn/tools/<makine>.json` dosyasına yazabilir; en az biri varsa Araçlar sekmesi her aracı türü, hangi makinelerde
olduğu, kullanım sayısı ve açıklamasıyla listeler. Biçim, sürüm 1:
`{ "version": 1, "machine": "dizustu", "scannedAt": "2026-11-14T09:00:00Z", "tools": [{ "name": "fener",
"kind": "skill", "description": "…", "cost": "…", "link": "https://…", "uses": { "count": 3, "last": "2026-11-13" } }]
}`. Araç başına
yalnız `name` zorunludur; bağlantı `https://`, `http://` ya da `obsidian://` ile başlamalıdır. 1 MB'tan büyük, başka
sürümde ya da bozuk dosya uyarıyla atlanır. Görüntüler kayıt değildir: değişiklik izi, arama ve yedek dışındadır.
