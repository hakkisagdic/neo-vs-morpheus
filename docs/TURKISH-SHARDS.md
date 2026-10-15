# Türk Ultima Online shard'ları — Ekim 2026 taraması

**Tarih:** 15 Ekim 2026 (Perşembe). Nüfus ölçümleri ~16:00–16:30 TSİ arasında alındı. Hafta içi öğleden sonra olduğu için akşam saatlerinde (20:00–24:00) sayılar büyük olasılıkla daha yüksek.

**Yöntem ve sınırlar**
- Yalnız herkese açık sayfalar okundu. Hesap açılmadı, giriş yapılmadı, launcher ya da istemci indirilmedi, kimseye mesaj yazılmadı. Dosya adları yalnız indirme sayfalarındaki bağlantı adlarından okundu.
- **pyramiduo.com** Cloudflare insan doğrulaması (Turnstile) arkasında. Doğrulama çözülmedi, site okunamadı. Pyramid bilgileri listelerden ve forumlardan geliyor.
- **Discord Türkiye'de Ekim 2024'ten beri erişime kapalı.** Bu makineden de discord.com bağlantısı reddedildi. Bu yüzden Discord'daki kural kanalları okunamadı. Bazı shard'lar Telegram'a ya da foruma geçti (UORoots, World of UO, Nephilim, Valor).
- Kurallar alıntılanmadı, kendi cümlelerimle özetlendi. Asıl metinler bağlantılarda.

**Kaynak kısaltmaları (hepsi 15.10.2026'da okundu)**
- **US** — [Ultima-Strike UO server listesi](https://www.ultima-strike.com/uoserverlist). Sayılar 10 dakikada bir yenileniyor. "Liste rekoru", listenin MAKS sütunu, yani listenin gördüğü en yüksek eşzamanlı sayı.
- **UD** — [uo-developer.com Türkiye listesi](https://www.uo-developer.com/uoserverlist/tr) ve [tüm liste](https://www.uo-developer.com/uoserverlist/), 15 dakikada bir yenileniyor. Detay sayfalarında tarihli rekor var. UD'deki "makro politikası" alanı çoğu shard'da aynı değeri gösteriyor ve muhtemelen varsayılan, bu yüzden yalnız farklı olduğu yerde anıldı.
- **UOTR** — [ultima-online.com.tr sunucu listesi](https://www.ultima-online.com.tr/uoserverlistesi).
- **site** — shard'ın kendi sayfası ya da kendi istatistik ucu.
- [ultima.venus.gen.tr listesi](https://ultima.venus.gen.tr/index.php?liste=sunucu) artık yalnız UO Outlands'i gösteriyor, Türk shard'ı yok.
- Duyuru forumları: [Ultima-Strike › Sunucular](https://www.ultima-strike.com/forum/ultima-online/sunucular), [uo-developer › Server Reklam](https://www.uo-developer.com/s-30-server-reklam-tartisma.html).

O anda listelenmiş Türk shard'larında toplam ~240 kişi online'dı.

---

## Özet tablo

| Shard | Emülatör · dönem · odak | Nüfus (15.10.2026 ~16:00 TSİ) | İstemci → Mac uyumu | 3. parti kuralları (kısaca) | Durum |
|---|---|---|---|---|---|
| **Nero PvP** | Sphere · ML (UD) · PvP, sınıflı (warrior/warlock/mage) | 48 (site API, UD); rekor 61 (14.10.2026, UD); 8–13 Eki günlük tepe 15–28 (site API) | Kendi connector'ı (.rar, Windows) → CrossOver | Kural metni yayımlanmamış; UD alanı: asistan kısıtlı | Aktif, 20.09.2026'da açıldı |
| **Nephilim PvP** | Sphere 0.56T · custom · PvP, skill cap yok | 46 (US, UD, UOTR); rekor 211 (02.08.2025, UD) | FPS client (.rar) + ML kurulumu → CrossOver; US'de MobileUO etiketi | Kural metni bulunamadı; kendi makro aracını dağıtıyor | Aktif, 02.12.2023'ten beri; Eylül 2026'da yeni sezon |
| **Pyramid UO** | Sphere · bilinmiyor · PP | 36 (US); liste rekoru 93; Discord'da 92 online (US) | US'ye göre ClassicUO; site okunamadı | Forumda (Eyl 2026): Makroman çalışıyor ama ara ara anti-makro kodu çıkıyor | Aktif; 2006'dan beri olduğunu söylüyor |
| **UO:Nimloth** | Sphere 0.56T · T2A (UD) · PP, 7x/700, 225 | 28–30 (site, US, UD, UOTR); rekor 57 (08.10.2026, UD) | UOSoft ClassicUO, Windows setup (.zip, VC++ x64) → CrossOver | Kural sayfası boş; multi-client serbest (yetkili, Kas 2025); harici makro aracı çalışmıyor (oyuncu) | Aktif, 31.10.2025'te yeniden açıldı |
| **Rampage PvP** | Sphere · ML · PvP | 29 (site, US); liste rekoru 118 | UOSoft yapımı istemci, Win 10/11 64-bit + patcher (.NET 8) → CrossOver | Kural sayfası boş; indirme sayfasında Razor isteğe bağlı; anti-cheat olduğunu söylüyor | Aktif (Nis 2025, Tem 2026'da yeniden açıldı) |
| **Nebula UO** | Sphere (US) · bilinmiyor · PP, 7x | 19 (US); liste rekoru 557 | Kendi "FPS" istemcisi (.rar, UO kurulumu gerekmez) → CrossOver | Yalnız kendi loop/makro aracı serbest, başka her program yasak (kalıcı ban); multi-client etkinlik dışında serbest; AFK toplama yasak | Aktif; 1999'dan beri olduğunu söylüyor |
| **Medieval UO** | Sphere 0.56b nightly · bilinmiyor · PvP+PvM, 7x/225 | 19 (site); tepe 42 (site) | FPS client (ClassicUO tabanlı, .zip) → CrossOver | Kural bulunamadı; kendi makro tekrar programı var; 3 multi-client | Aktif, 09.10.2026'da açıldı |
| **World of UO** | RunUO · AoS (7.0.20.0) · RP, sezonlu | Ölçülemedi, oyun portu kapalı (UD); rekor 149 (02.10.2026, UD); liste rekoru 573 (US) | Kendi launcher'ı (.exe) → CrossOver | Razor ve EasyUO dahil tüm 3. parti yasak; yalnız kendi bağlantı programı | Geçici kapalı: site hizmet dışı (15.10.2026) |
| **NightUO** | Sphere 0.56T · Renaissance (UD) · PP, 800 skill | 6–7 (US, UD, UOTR); rekor 38 (02.12.2025, UD) | Classic tabanlı FPS connector → CrossOver | Kendi Macroman paketini dağıtıyor; kural metni bulunamadı | Aktif, 01.01.2025'ten beri |
| **Eryndor UO** | Custom Sphere · ML · PK+PvE, faction, 8x | 6–8 (US, UD); rekor 19 (14.10.2026, UD) | Setup .exe + "Eryndor Guard" anti-cheat → CrossOver riskli | Oyun sırasında 3. parti, otomasyon ya da hile sayılabilecek yazılım açık olmamalı; Guard sanallaştırma/sandbox arıyor | Test dönemi (12.10.2026'dan itibaren 15 gün) |
| **New Hope UO** | ServUO (.NET) · custom ML · PvM/craft/deniz | 2 (US, UD); rekor 19 (13.09.2026, UD) | Tarayıcı (resmi ClassicUO Web) + Windows launcher → **Mac: tarayıcı** | Hile ve izinsiz 3. parti program yasak; anti-cheat var | Aktif (Haz 2026); İngilizce site, Türk ekip |
| **Valor UO** | Sphere 56s (özel) · oldschool · PP, 7x | 1–2 (site, US); liste rekoru 67 | Modifiye ClassicUO: Windows, **native macOS** (imzalı, notarize) ve tarayıcı | Connector'ın ekran görüntüsü almadığını, donanım kimliği toplamadığını, başka programlara karışmadığını yazıyor; ayrıntılı kural bulunamadı | Sunucu açık ama sessiz (forumda son hareket Ara 2024) |
| **Alcor UO Reborn** | Sphere 56T · RP & PP · 800 skill | 1 (US); liste rekoru 77 | ClassicUO tabanlı connector + UOSoft koruması (.zip) → CrossOver riskli | Connector açıkken bilgisayardaki diğer uygulamaları sorguluyor; connector'sız giriş yasak | Aktif (03.09.2024'ten beri) |
| **Haldi UO** | Sphere 56b · T2A (UD) · PvP, PC+mobil | 0–1 (site, UD, UOTR); rekor 7 (UD) | FPS 6x client (.exe) → CrossOver | Kural bulunamadı | Aktif ama boş |
| **TroyUO** | ServUO · ML · RP-PP (UD) | 1 (UD); rekor 6 (UD) | Launcher → CrossOver | Kural ve yasaklı program listesi "hazırlanıyor"; UD alanı: makro tamamen serbest | Aktif (Tem 2026) |
| **UORoots** | RunUO · AoS/SE/ML çerçevesi, tek Felucca · RP-PP | 0 (US, UD, UOTR); rekor 9 (28.09.2026, UD) | Windows launcher + **tarayıcı istemcisi (macOS/Linux için resmi yol)** | Yazılı ve net: yalnız kendi istemcisi + Türkçe Razor; diğer asistanlar, OCR, ağ dinleyen ve bellek okuyan programlar, istemci eklentileri yasak; başındayken makro serbest, AFK yasak | Aktif (Eylül 2026) |
| **World of Sosaria** | RunUO · AoS · RP/PvP | Henüz yok | Bilinmiyor (site yalnız JavaScript) | 2024 sürümünde oyun içi makrolar ve yazılım engelleme vardı | 23.10.2026 21:00'de açılacak |
| **Ultimate World** (ultimateuo.com) | ServUO · ML, Felucca ağırlıklı | Ölçülemedi (sitedeki online listesi boş, listelerde yok) | Windows launcher; web client "yakında" → CrossOver | Yalnız kendi istemcisi ve programları; Razor istemciye gömülü, harici program kapalı; hız programı yasak | Açık olduğunu söylüyor (25.09.2026) |
| **West UO** | Bilinmiyor · 8x | — | — | — | Açılmadı ("yakında") |
| **Volantis UO** | Sphere · bilinmiyor | — | Windows istemcisi testte, web client hazırlanıyor | Macroman istemciye gömülü (site metni) | Geliştirme, yerel test |
| **Atlantis Shard** | RunUO + Sphere · T2A/Renaissance | 0, 13 hesap, sunucular kapalı (site) | Bilinmiyor | Bilinmiyor | Test aşaması |
| **Esgaroth UO** | Sphere 56b nightly · PP · 800 | 0; istatistik sayfası sunucuyu kapalı gösteriyor; rekor 5 | Drolyn connector | Bilinmiyor | Kapalı görünüyor |
| **Alysa PvP** | Sphere 56b · PvP · 800 | — | Ultima-Destek connector'ı | Bilinmiyor | Ramazan etkinlik sunucusuydu (Şub 2026); site "yenileniyor" |
| **Harm PvP · Royal UO · Nicomedia · Aura UO** | Çeşitli | — | — | Royal'de multi-client yasaktı | Siteler erişilemedi ya da durum belirsiz |
| *Türk değil:* **UO Second Age** | RunUO · T2A · İngilizce | 41 (UD); rekor 87 (05.10.2026, UD) | ClassicUOSA + UOSA Assist + launcher → Mac: belirtilmemiş | Yalnız resmi istemci, Razor/UOSA Assist, UO AutoMap; Razor ile gözetimsiz makro serbest, gözetimsiz toplama yasak; en fazla 3 hesap | Aktif (2007'den beri) |
| *Türk değil:* **Imperial Shard** | RunUO · Renaissance · PvP (Brezilya) | 235 (UD); rekor 279 (22.09.2026, UD) | ClassicUO (UD) | — | Aktif |

---

## Shard ayrıntıları

### Nero PvP
- **Site:** https://www.nero.gen.tr/ · [dosyalar](https://www.nero.gen.tr/index.php?page=dosyalar) · [sistemler](https://www.nero.gen.tr/index.php?page=sistemler) · Discord: discord.gg/umpPwMmRSz (listeler), discord.gg/Tagk7YN2Vb (site)
- **Emülatör, dönem, odak:** Sphere. Stats sayfası verinin "Sphere bağlantısından" geldiğini söylüyor. UD'de ML. PvP odaklı: warrior/warlock/mage sınıfları, düello, 2v2, kale savaşı, CTF. Hesap ücretsiz. VIP ve market puanı sistemi var.
- **Nüfus:** Sitenin herkese açık istatistik ucuna göre 13:07 UTC'de 48 oyuncu, tepe 61. Aynı ucun geçmişinde 8–13 Ekim arası günlük tepe 15–28. UD'de 48, rekor 61 (14.10.2026). US'de 48, liste rekoru 61, 739 karakter.
- **İstemci ve Mac:** Tek dosya `NeroPVPConnector.rar` (Windows). US'ye göre ClassicUO. Mac'te CrossOver gerekir.
- **Kurallar:** Sitede kuralları buradan takip edin diyen bir sayfa var ama kural metni yok. UD alanı "asistan kısıtlı" diyor. Makro, multi-client ya da kayıt/yayın hakkında açık metin bulunamadı.
- **Durum:** Aktif, 20.09.2026'da açıldı.
- **Kaynaklar:** [uo-developer duyurusu](https://www.uo-developer.com/q-10916-nero-pvp-20092026-pazar-gunu-sizlerle.html) · [UD detay](https://www.uo-developer.com/uoserverlist/713-nero-pvp) · [Ultima-Strike duyurusu](https://www.ultima-strike.com/forum/ultima-online/sunucular/nero-pvp-20-09-2026-pazar-q52672)

### Nephilim PvP
- **Site:** https://www.nephilim.gen.tr/ · [dosyalar](https://www.nephilim.gen.tr/dosyalar/) · Telegram t.me/nephilimpvp · Discord discord.gg/zrkCu9Tv65 · Twitch, YouTube, TikTok hesapları var. Forum sayfası 500 hatası veriyor, wiki boş.
- **Emülatör, dönem, odak:** Sphere 0.56T. PvP, skill cap yok, stat 225. UD'de dönem "custom". Sitede tür Power Play yazıyor.
- **Nüfus:** 46 (US, UD, UOTR aynı anda). UD rekoru 211 (02.08.2025), US liste rekoru 156.
- **İstemci ve Mac:** UO Mondain's Legacy kurulumu + `NephilimUOSetup.rar` (FPS client) + kendi makro aracı `NephilimMakro.rar`. US etiketi ClassicUO + MobileUO. Mac'te CrossOver gerekir.
- **Kurallar:** Sitede kural metni bulunamadı (wiki boş, forum çalışmıyor). Kendi makro aracını resmi dosya olarak dağıtıyor, yani bir tür makroya izin var. Kayıt ve yayın hakkında bir şey yok; kendi Twitch kanalı var.
- **Durum:** Aktif. 02.12.2023'te açıldı, Eylül 2026'da "Age of Gold" sezonu duyuruldu.
- **Kaynaklar:** [UD duyurusu 2023–2025](https://www.uo-developer.com/q-10841-nephilim-pvp-turkiyenin-en-iyi-pvp-sunucusu-2023-2025.html) · [Ultima-Strike Age of Gold](https://www.ultima-strike.com/forum/ultima-online/sunucular/nephilim-pvp-age-of-gold-q52677) · [UD detay](https://www.uo-developer.com/uoserverlist/660-nephilim-uo)

### Pyramid UO
- **Site:** https://www.pyramiduo.com/ (Cloudflare insan doğrulaması arkasında; okunamadı) · Discord discord.gg/GWVaxKM
- **Emülatör, dönem, odak:** US'ye göre Sphere ve PP. Dönem bilinmiyor. Discord tanıtımında 2006'dan beri olduğunu söylüyor (web aramasında görülen özet). Forumlarda 2018'de kapanıp yeniden açıldığı konuşuluyor.
- **Nüfus:** 36 (US), liste rekoru 93, Discord'da 92 kişi online (US). UD ve UOTR listelerinde yok.
- **İstemci ve Mac:** US etiketi ClassicUO. Launcher'ın türü bilinmiyor; site okunamadığı için Mac uyumu bilinmiyor.
- **Kurallar:** Eylül 2026'daki bir forum mesajına göre Makroman kullanılabiliyor, ama ara ara güvenlik (anti-makro) kodu çıkıyor. Resmi kural metni okunamadı. **Kuralları siteyi kendiniz açıp okumalısınız.**
- **Durum:** Aktif.
- **Kaynaklar:** [US listesi](https://www.ultima-strike.com/uoserverlist) · [Makroman konusu](https://www.uo-developer.com/q-10914-makroman-calisan-sunucu-kalmadi-mi.html)

### UO:Nimloth
- **Site:** https://uo-nimloth.net/ · [dosyalar](https://uo-nimloth.net/dosyalar) · [wiki (GitBook)](https://nimloth-uo.gitbook.io/wiki) · Discord discord.gg/nygREe5Rff · Kick kick.com/uonimloth · YouTube @uonimloth
- **Emülatör, dönem, odak:** Sphere 0.56T (site). PP, skill cap 700 (7x), stat 225. UD'de T2A. Yoğun craft, ekonomi ve sipariş sistemleri var. 2026 Q3/Q4 yol haritası yayımlanmış, 2027'de sezon sistemi geliyor.
- **Nüfus:** Site 28 (482 günlük dünya, 1.482 hesap, 7.674 karakter). UD 30, rekor 57 (08.10.2026). US 28, liste rekoru 129. UOTR 29.
- **İstemci ve Mac:** "ClassicUO (UOSoft)". Windows setup `Nimloth_Setup.zip`; UO kurulumu gerekmez, x64 VC++ gerekir. Mac'te CrossOver gerekir. UOSoft istemcisinde bir bağlantı koruması olabilir; CrossOver'da çalışıp çalışmadığı bilinmiyor.
- **Kurallar:** Sitedeki "Şartlar ve kurallar" sayfası boş, yer tutucu metin duruyor. Bir yetkili Kasım 2025'te multi-client açılabildiğini yazdı. Bir oyuncu Eylül 2026'da Makroman'ın burada çalışmadığını yazdı. Balıkçılık gibi işlerde sürekli başında olmak gerektiği konuşuluyor. Kayıt ve yayın hakkında bir şey yok; kendi Kick kanalı var.
- **Durum:** Aktif. 20.10.2025'te duyuruldu, 31.10.2025'te yeniden açıldı (1. yıl dönümü 31 Ekim). Forumda oyuncular en çok bunu öneriyor.
- **Kaynaklar:** [Ultima-Strike konusu](https://www.ultima-strike.com/forum/ultima-online/sunucular/uo-nimloth-yeniden-doguyo-q52625) · [UD detay](https://www.uo-developer.com/uoserverlist/685-uo-nimloth) · [öneri konusu](https://www.ultima-strike.com/forum/ultima-online/sunucular/duzgun-bir-rp-ya-da-pp-yo-q52671)

### Rampage PvP
- **Site:** https://rampage.gen.tr/ · [dosyalar](https://rampage.gen.tr/dosyalar) · [wiki](https://rampage-pvp.gitbook.io/wiki) · Discord discord.gg/QhVK954bYp (site), discord.gg/AmqFudHhwU (US) · Kick
- **Emülatör, dönem, odak:** Listelere göre Sphere. Site: PvP, expansion ML, stat 225. Çok sayıda özel sistemi var (PvP lig, guild istila, solo dungeon).
- **Nüfus:** Site 29 (2.018 hesap, 2.267 karakter). US 29, liste rekoru 118.
- **İstemci ve Mac:** "Coded by UOSoft". Win 10/11 64-bit tam paket (1 GB, son güncelleme 10.05.2026), .NET 8 + VC++ ve patcher. Mac'te CrossOver gerekir.
- **Kurallar:** Kurallar sayfası ve SSS boş, yer tutucu metin duruyor. İndirme rehberinde Razor kullanımının isteğe bağlı olduğu yazıyor. Sitede "anti-cheat sistemleri" olduğu söyleniyor. Wiki'deki jail sayfasından makroya bırakıp kazmanın yasak olduğu anlaşılıyor.
- **Durum:** Aktif. 05.04.2025'te açıldı, Temmuz 2026'da yeniden açıldı, Ekim 2026'da güncelleme notları var.
- **Kaynaklar:** [dosyalar](https://rampage.gen.tr/dosyalar) · [Ultima-Strike 2026](https://www.ultima-strike.com/forum/ultima-online/sunucular/rampage-uo-pvp-acilmistir-q52668)

### Nebula UO
- **Site:** https://nebula.web.tr/ · [dosyalar](https://nebula.web.tr/dosyalar/) · [wiki](https://nebula.web.tr/wiki/index.php/Anasayfa) · Discord discord.gg/KC7R3c9FvP · forum PHP hatası veriyor
- **Emülatör, dönem, odak:** US'ye göre Sphere. PP, 7x, power hour açık. Silah sınıfları dengesi, etkinlikler var. Market'te parayla "Nebula Puan" satılıyor. 1999'dan beri kesintisiz olduğunu söylüyor.
- **Nüfus:** 19 (US), liste rekoru 557, Discord'da 82 online. UD ve UOTR listelerinde yok.
- **İstemci ve Mac:** `Nebula_Setup.rar` (UO kurulumu gerekmez) ya da ML + "FPS connector". İzinli makro aracı UDProtect bileşeniyle geliyor. Mac'te CrossOver gerekir; koruma bileşeni nedeniyle risk var.
- **Kurallar** ([Diğer Kurallar](https://nebula.web.tr/wiki/index.php/Di%C4%9Fer_Kurallar)): Kullanımı serbest tek program Nebula'nın kendi loop/makro aracı. Diğer bütün programlar yasak; tespit edilirse hesap süresiz kapanıyor ve bir hafta sonra siliniyor. AFK toplama ve AFK quest yasak. Multi-client aksiyon, skill ve para kasmak için serbest, ama etkinliklere aynı IP'den tek karakterle girilmeli. Toplama becerilerinde rastgele makro kontrol ekranı çıkıyor. Oyunculardan gelen ekran görüntüleri kanıt sayılmıyor. Kayıt ve yayın hakkında bir şey yok.
- **Durum:** Aktif.

### Medieval UO
- **Site:** https://www.medievaluo.com/ (tek sayfalık uygulama; veriler sayfaya gömülü)
- **Emülatör, dönem, odak:** Sphere 0.56b nightly. Stat 225, skill 7x. Türkçe optimize edilmiş Classic UO paneli. PK kalesi, PvP ve PvM.
- **Nüfus:** Site 13:24 UTC'de 19 online, tepe 42, 4.139 karakter, 11 gündür açık.
- **İstemci ve Mac:** "FPS Client" tam kurulum (`MedievalUOSetup.zip`, ClassicUO altyapısı) + kendi makro tekrar programı. Mac'te CrossOver gerekir.
- **Kurallar:** Wiki'de program ya da makro kuralı bulunamadı. Duyuruya göre 3 multi-client açılabiliyor.
- **Durum:** Aktif, 09.10.2026'da açıldı.
- **Kaynak:** [uo-developer duyurusu](https://www.uo-developer.com/q-10927-medieval-uo-9-ekim-saat-1900da-kapilarini-aciyor.html)

### World of UO
- **Site:** https://www.worldofuo.com/ (15.10.2026'da geçici hizmet dışı) · [forum](http://forum.worldofuo.com/) (son mesajlar 2024) · Telegram t.me/worldofuo · Discord discord.gg/mCTsDx67dX
- **Emülatör, dönem, odak:** RunUO, Age of Shadows (istemci 7.0.20.0). RP, sezonlu ilerleme. Başlangıçta 7 skill seçiliyor, her akşam Britain kale savaşı var.
- **Nüfus:** UD oyun portuna bağlanamadı. UD rekoru 149 (02.10.2026). US online yok, liste rekoru 573, Discord'da 103 online. Ekip ilk sezonda 100'ü aşkın tekil oyuncu olduğunu yazdı.
- **İstemci ve Mac:** `WorldofUOLauncher.exe` (Windows). US etiketi ClassicUO + MobileUO. Mac'te CrossOver gerekir.
- **Kurallar:** Duyuruya göre Razor ve EasyUO dahil bütün üçüncü parti uygulamalar yasak, oyuna yalnız kendi bağlantı programıyla girilebiliyor. Kıyafet giyme, ata binme gibi bazı oyun içi makrolar serbest. UD alanı "asistan kısıtlı".
- **Durum:** 24.10.2025'te açıldı (DonanımHaber'de 24 Kasım yazıyor, ama gönderi tarihi 30 Ekim). II. sezon 16.01.2026'da başladı. **Şu an geçici kapalı görünüyor.**
- **Kaynaklar:** [Ultima-Strike duyurusu](https://www.ultima-strike.com/forum/ultima-online/sunucular/world-of-uo-da-gecmise-yo-q52626) · [DonanımHaber](https://forum.donanimhaber.com/world-of-uo-2025-age-of-shadows--162405654) · [UD detay](https://www.uo-developer.com/uoserverlist/710-world-of-uo)

### NightUO
- **Site:** https://nightuo.gen.tr/ · [dosyalar](https://nightuo.gen.tr/dosyalar.php) · Discord discord.gg/cmvW3evFqj
- **Emülatör, dönem, odak:** Sphere 56T. PP, skill cap 800, stat 225. UD'de Renaissance. 89 sistem, sık haber akışı (son haber 04.10.2026).
- **Nüfus:** 6 (US, UD), 7 (UOTR). UD rekoru 38 (02.12.2025), US liste rekoru 132.
- **İstemci ve Mac:** Classic client tabanlı FPS connector + ML + "NightUO Macroman" paketi. Mac'te CrossOver gerekir.
- **Kurallar:** Kural metni bulunamadı. Duyuruya göre yeni istemciyle Macroman 2.0 kullanımı açıldı.
- **Durum:** Aktif, 01.01.2025'ten beri.
- **Kaynak:** [uo-developer duyurusu](https://www.uo-developer.com/q-10844-nightuo-pp-server.html)

### Eryndor UO
- **Site:** https://www.eryndoruo.com/ · [kullanım koşulları](https://www.eryndoruo.com/kullanim-kosullari.php) · [dosyalar](https://www.eryndoruo.com/dosyalar.php) · Discord discord.gg/A76UaSZqWY
- **Emülatör, dönem, odak:** Custom Sphere, ML. PK ve PvE, British–Blackthorne faction savaşı. 8x, power hour %100. P2W olmadığını söylüyor.
- **Nüfus:** US 6, UD 8. UD rekoru 19 (14.10.2026).
- **İstemci ve Mac:** `Eryndor-UO-Setup-v0.8.5.exe` + ML + UO Loop + VC++ x64. Eryndor Guard anti-cheat var. **Kullanım koşullarına göre Guard sandbox ve sanallaştırma da arıyor ve şüphede istemciyi kapatabiliyor. CrossOver'ın bu kontrole takılma ihtimali yüksek.**
- **Kurallar:** Oyun sırasında üçüncü parti, otomasyon ya da hile sayılabilecek yazılımlar açık olmamalı. Overlay ve benzeri yazılımlar Guard ile çakışabilir. Resmi yardımcı program UO Loop. Bir oyuncu multi-client açılmadığını yazdı.
- **Durum:** Test dönemi; 12.10.2026'da açıldı, 15 gün test.

### New Hope UO
- **Site:** https://www.newhopeuo.com/ · [tarayıcıda oyna](https://play.classicuo.org/?shard=103) · [wiki](https://wiki.newhopeuo.com/) · [forum](http://forum.newhopeuo.com/) · Discord discord.gg/5uMgns7Q6j · Reddit r/newhopeuo
- **Emülatör, dönem, odak:** ServUO, modern .NET. Custom ML. Class kitapları, binek çiftleştirme, savaş gemileri, PvM ve crafting. P2W olmadığını söylüyor. Site İngilizce, Türk forumlarında Türkçe tanıtılıyor.
- **Nüfus:** 2 (US, UD), UD rekoru 19 (13.09.2026). Sitedeki 24 aktif oyuncu yazısı güncel veri olmayabilir.
- **İstemci ve Mac:** Üç yol var: tarayıcıda resmi ClassicUO Web (Safari ve Chrome sayılıyor), 5.9 MB launcher (Razor/ClassicUO açar) ve 2.2 GB tam paket. **Mac'te tarayıcı yolu en kolayı.**
- **Kurallar:** Hile, speedhack ve izinsiz üçüncü parti programlar yasak. Anti-cheat ya da yetkililer tespit ederse kalıcı ban. Launcher Razor'ı kendisi açtığı için Razor izinli görünüyor. Kayıt ve yayın hakkında bir şey yok.
- **Durum:** Aktif (Haziran 2026'dan beri).
- **Kaynak:** [Ultima-Strike duyurusu](https://www.ultima-strike.com/forum/ultima-online/sunucular/new-hope-uo-custom-ml-era-q52664)

### Valor UO
- **Site:** https://valor.gen.tr/ · [dosyalar](https://valor.gen.tr/dosyalar/) · [hakkında](https://valor.gen.tr/hakkinda/) · [web client](https://oyna.valor.gen.tr/) · [forum](https://forum.valor.gen.tr/)
- **Emülatör, dönem, odak:** Sphere 56s (sunucuya özel derleme). Eski tarz, 7x, 225, hırsızlık dışı becerilerde power hour açık. Bağışla eşya satışı olmadığını söylüyor. 2004'te 500'ü aşkın oyuncuya ulaşmış, 2015'te yeniden açılmış.
- **Nüfus:** Site 1, US 2, liste rekoru 67. Forumdaki son hareket Aralık 2024.
- **İstemci ve Mac:** Modifiye ClassicUO ("Valorite"). Windows installer ya da zip, **native macOS istemcisi (Apple Geliştirici hesabıyla imzalanmış ve notarize edilmiş)**, ayrıca tarayıcı istemcisi. Forumda Mac kullanan oyuncular var.
- **Kurallar:** Dosyalar sayfasına göre connector ekran görüntüsü almıyor, MAC adresi gibi donanım bilgisi toplamıyor, başka programlara karışmıyor. Ayrıntılı kural metni bulunamadı. Forumda .uoloop komutunun istemcide açıldığı yazıyor.
- **Durum:** Sunucu açık, topluluk çok sessiz.

### Alcor UO Reborn
- **Site:** https://alcoruo.gen.tr/ · [dosyalar](https://alcoruo.gen.tr/dosyalar) · forum.alcoruo.gen.tr · Discord discord.gg/3kFfeUSyWa
- **Emülatör, dönem, odak:** Sphere 56T ("T" Türkiye; 56b #1593 tabanlı, 64-bit). RP & PP, skill 800, stat 225. Türkiye'de barındırılıyor.
- **Nüfus:** 1 (US), liste rekoru 77.
- **İstemci ve Mac:** ClassicUO tabanlı connector (`Alcor_Setup.zip`) ve UOSoft koruması. Mac'te CrossOver gerekir ve risklidir.
- **Kurallar:** Connector olmadan oyuna giriş kabul edilmiyor. Connector açıkken bilgisayarda açık olan diğer uygulamaları hile tespiti için sorguladığı açıkça yazıyor.
- **Durum:** Aktif (03.09.2024'ten beri), ama neredeyse boş.

### Haldi UO
- https://haldiuo.com/ · Discord discord.com/invite/vr5VXpFArZ. Sphere 56b, PvP, FPS 6x client (`HaldiUo.exe`), mobil bağlantı sayfası var. 0–1 online (site, UD, UOTR), UD rekoru 7. Kural bulunamadı. Son haber Nisan 2024. [Duyuru](https://www.uo-developer.com/q-10781-haldi-uo-pcmobile.html)

### TroyUO
- https://troyuo.com/. ServUO, ML. Launcher var, kayıt açık. UD'de 1 online, rekor 6. [Kurallar](https://troyuo.com/kurallar) ve [yasaklı programlar](https://troyuo.com/yasakli) sayfaları "yakında yayınlanacak" diyor. Asistan makroları, speedhack ve diğer 3. parti programların yasaklanacağı belirtilmiş. UD alanı makroyu "tamamen serbest" gösteriyor ve bu sitedeki niyetle çelişiyor. [Duyuru](https://www.uo-developer.com/q-10910-troyuo-ultima-online-sunucu-projesi.html)

### UORoots
- **Site:** https://uoroots.com/ · [sunucu kuralları](https://uoroots.com/sunucu-kurallari) · [kurulum](https://uoroots.com/rehber/kurulum) · tarayıcı: oyna.uoroots.com (TR), play.uoroots.com (EN) · Discord discord.gg/DxeZScWx24 · resmi topluluk kanalı Telegram
- **Emülatör, dönem, odak:** Listelere göre RunUO. AoS/SE/ML çerçevesi. Trammel ve Tokuno kapalı, tek Felucca (tam ganimet PvP), Ilshenar ve Malas güvenli. Skill 700 (veteran 720), stat 225, skill kazanımı 2x. Oyun baştan sona Türkçe. Sohbeti yapay zekâ destekli bir moderatör izliyor.
- **Nüfus:** 0 (US, UD, UOTR). UD rekoru 9 (28.09.2026).
- **İstemci ve Mac:** Windows 10/11 64-bit tam paket (~1.5 GB) ve launcher (Türkçe Razor CE dahil). **macOS ve Linux için resmi yol tarayıcı istemcisi; tarayıcıda Razor yok.**
- **Kurallar** (en açık yazılmış kural seti):
  - Yalnız UORoots istemcisiyle girilir; izinli tek asistan Türkçe Razor.
  - Razor Enhanced, UOSteam, ClassicAssist, EasyUO, Stealth, AutoHotkey ve benzerleri yasak.
  - Ekranı okuyan (OCR), ağ trafiğini dinleyen ya da bellek okuyan programlar yasak.
  - İstemci dosyasını değiştirmek ya da istemciye eklenti koymak yasak.
  - Başındayken makro serbest; başında değilken skill, kaynak ya da kamp yasak.
  - Aynı anda en fazla 3 karakter; PvP'de kişi başı tek karakter.
  - 18 yaş sınırı var; başkasının kişisel bilgisini paylaşmak yasak.
  - Şikâyetlerde ekran görüntüsü ya da video kabul ediliyor. Kendi oyununu kaydetmeye dair bir yasak yok.
- **Durum:** Aktif (Eylül 2026'dan beri), nüfus çok düşük.
- **Kaynak:** [Ultima-Strike duyurusu](https://www.ultima-strike.com/forum/ultima-online/sunucular/uoroots-koklerine-don-bas-q52678)

### Yeni ya da henüz açılmamış shard'lar
- **World of Sosaria** — https://worldofsosaria.com.tr · Discord discord.gg/YA8F3v4JtD. RunUO, 23.10.2026 21:00'de açılıyor. 2024 sürümü AoS ve RP/PvP idi; oyun içi PvP, bandaj ve craft makroları ile "yazılım engelleme" vardı. Bir forum yorumuna göre (Aralık 2024) AoS döneminde 150'yi aşan oyuncuyu görmüştü. [2026](https://www.uo-developer.com/q-10928-world-of-sosaria-runuo-sunucusu-23-ekim-saat-2100da-aciliyor.html) · [2024](https://www.uo-developer.com/q-10826-world-of-sosaria-legends-aciliyor.html)
- **Ultimate World / Ultimate UO** — https://ultimateuo.com. ServUO, ML, Felucca ağırlıklı. Launcher yalnız Windows (`UltimateWorld.exe`), web client "yakında". [Kurallara](https://ultimateuo.com/kurallar.php) göre yalnız kendi istemcisi ve programlarıyla girilebiliyor, hız programları yasak, izinsiz makro banı kaldırılmıyor. Oyuncular arasında gerçek parayla alışveriş serbest. IP başına en fazla 5 hesap. Sitedeki online listesi boş. 25.09.2026'da açılmış. [Duyuru](https://www.uo-developer.com/q-10915-ultimate-uo-yeni-sezon.html)
- **West UO** — https://west.gen.tr. 8x, 4 dilli site, kapalı ön izleme. Açılmadı. [Duyuru](https://www.uo-developer.com/q-10926-west-uo-hayat-offline-yakinda.html)
- **Volantis UO** — https://volantisuo.com. Sphere tabanlı, geliştirme ve yerel test aşamasında. Windows istemcisi testte; Google girişli web client hazırlanıyor; istemciye gömülü Macroman var. [Duyuru](https://www.uo-developer.com/q-10843-volantis-ultima-online.html)
- **Atlantis Shard** — https://atlantisuo.com. RunUO + Sphere, T2A/Renaissance. Sitede test değerleri, 0 online, 13 hesap; iki sunucu da kapalı.

### Kapalı ya da durumu belirsiz (2025–2026'da adı geçen)
- **Esgaroth UO** (esgarothuo.com) — Sphere 56b nightly, PP, 800, Drolyn connector. 15.03.2025'te açıldı. [İstatistik sayfası](https://istatistik.esgarothforum.com/) sunucuyu kapalı gösteriyor, rekor 5.
- **Alysa PvP** (alysauo.gen.tr) — Sphere 56b, 19.02.2026'da açılan hızlandırılmış Ramazan etkinlik sunucusu. Site "yenileniyor" diyor.
- **Harm PvP** (harm.gen.tr) — 07.02.2026'da açıldı; 15.10.2026'da siteye erişilemedi.
- **Royal UO** (royaluo.com) — 01.09.2023'te açıldı, forumda mesajlar Aralık 2025'e kadar var. Multi-client yasaktı, oyuncular arası gerçek para ticareti serbestti. Siteye erişilemedi.
- **Nicomedia UO** — RunUO 2.1, AoS benzeri, yalnız Felucca + Ilshenar, RP. Ağustos 2025'te aktif görünüyordu, güncel bilgi yok. [Duyuru](https://www.uo-developer.com/q-10858-nicomedia-uo.html)
- **Aura UO** — UD'de TR, RunUO ML PvP. Erişilemiyor, rekor 1.
- 15.10.2026'da sitesine erişilemeyen eski projeler: Aries PvP, UO Battle (Sphere X PvP), Amnesia PvP, Linderia UO, TurkUO, Rest UO, Sindarin UO, Moniras, The North Shield. Hepsi muhtemelen kapalı.

### Türk olmayan ipuçları
- **UO Second Age** (uosecondage.com) — İngilizce, 2007'den beri, T2A. UD'ye göre RunUO. UD 41 online, rekor 87 (05.10.2026). İstemci ClassicUOSA 1.0 (ClassicUO'nun sadeleştirilmiş fork'u), asistan UOSA Assist (script'i çıkarılmış Razor fork'u) ve UOSA Launcher. Launcher'ın macOS desteği belirtilmemiş. [Kurallar](https://www.uosecondage.com/rules): yalnız resmi istemci, Razor/UOSA Assist ve UO AutoMap; Razor ile gözetimsiz makro serbest ama gözetimsiz toplama ve AFK satış yasak; en fazla 3 hesap.
- **Imperial Shard** — UD'de **Brezilya** bayraklı. RunUO, Renaissance, PvP, ClassicUO. 235 online, rekor 279 (22.09.2026). [UD detay](https://www.uo-developer.com/uoserverlist/697-imperial-shard)
- **"Nebula"** hatırası büyük olasılıkla Nebula UO (nebula.web.tr); başka bir Nebula shard'ı bulunamadı.

---

## Sonuç: Mac'te ilk kayıt oturumu

### En uygun görünenler
**1. Adım: teknik prova (az oyuncu, düşük risk)**
1. **UORoots (tarayıcı)** — macOS için resmi yol tarayıcı. Kurallar yazılı ve net. Yasaklananlar OCR, ağ dinleme, bellek okuma ve istemci eklentisi; macOS'un düz ekran ve ses kaydı bu listede yok. Türkçe. Eksi: nüfus 0–9.
2. **Valor UO (native macOS)** — imzalı ve notarize edilmiş Mac istemcisi var. Connector'ın başka programlara karışmadığını kendisi yazıyor, bu kaydedici için en rahat ifade. Eksi: neredeyse boş, topluluk sessiz.
3. **New Hope UO (resmi ClassicUO Web)** — Safari ya da Chrome'da çalışıyor; tarayıcı yolunda anti-cheat'li launcher devreye girmiyor. Eksi: 2–19 kişi; kural metni genel (izinsiz 3. parti yasak).

**2. Adım: gerçek oyuncularla veri (izin aldıktan sonra)**
- **UO:Nimloth** — oyuncuların en çok önerdiği PP topluluğu (28–57). Multi-client serbest. Ama istemci Windows ve UOSoft korumalı, CrossOver'da çalışıp çalışmadığı bilinmiyor; kural sayfası boş.
- **Nephilim PvP / Nero PvP** — Türk PvP'sinin en kalabalıkları (46–48). Proje PvP odaklı olduğu için en değerli veri buradan çıkar. İkisi de Windows connector'lı (CrossOver), kural metinleri yayımlanmamış.
- **Pyramid UO** — 36 kişi, 2006'dan beri. Site okunamadığı için istemci ve kurallar bilinmiyor; kendiniz bakmalısınız.

### Kaçınılacaklar ve nedeni
- **Eryndor UO** — Guard anti-cheat sandbox ve sanallaştırma arıyor, CrossOver büyük olasılıkla takılır. Oyun sırasında 3. parti yazılım açık olmamalı. Hâlâ test dönemi.
- **Alcor UO** — connector açık uygulamaları tarıyor ve bir kaydedici sorun çıkarabilir. Neredeyse boş.
- **Nebula UO** — kendi loop aracı dışındaki her program yasak, cezası kalıcı ban. Yazılı izin olmadan kaydedici bile risk.
- **World of UO** — Razor dahil bütün 3. parti uygulamalar yasak ve sunucu şu an kapalı. Açılınca ve izin alınınca yeniden bakılabilir.
- **Ultimate World** — yalnız kendi istemcisi ve programları kabul ediliyor, Mac için web client henüz yok, canlı nüfus verisi yok.
- Erişilemeyen ya da kapalı görünenler: Esgaroth, Harm, Royal, Aries, UO Battle, Amnesia, Linderia, TurkUO, Rest, Sindarin, Moniras, TNS, Atlantis (test).

### Kayıt için genel notlar
- **Kayıt ve yayın konusunda açık kural yazan shard bulunamadı.** UORoots şikâyetlerde video kabul ediyor; Nephilim, Nimloth ve Rampage'in kendi yayın kanalları var. Yine de her shard'da kayıttan önce yetkililere yazılı sorun. Discord engelli olduğu için Telegram, forum ya da e-posta kullanın.
- Yalnız macOS düzeyinde ekran ve ses kaydı (isterseniz kendi klavye ve fare kaydınız) kullanın. İstemci belleğini okuyan, ağ trafiğini dinleyen, istemciye eklenti koyan ya da canlı OCR yapan bir şey kullanmayın. UORoots bunları açıkça yasaklıyor; diğerlerinde genel "3. parti yasak" maddeleri bunları kapsayabilir. Kaydediciyi oyunun çalıştığı Windows (CrossOver) ortamına kurmayın.
- Kayıtlarda başka oyuncuların adları ve sohbetleri olacak. İleride bir şey yayımlanırsa bulanıklaştırın (UORoots başkasının kişisel bilgisini paylaşmayı yasaklıyor).
- Nüfus sayıları Perşembe öğleden sonrasına ait. Ekim 2025'te bir forum kullanıcısı Türk UO oyuncu havuzunu toplam 300–400 kişi olarak tahmin etmişti; bu taramadaki ~240 eşzamanlı oyuncu bununla uyumlu.
