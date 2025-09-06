# 📱 WhatsApp Bot (Baileys + Node.js)

Bot WhatsApp sederhana berbasis [Baileys](https://github.com/WhiskeySockets/Baileys) untuk keperluan personal / automation.  
Fitur utama:

- Auto-reply pesan masuk (`ping`, `menu`, dll)
- REST API sederhana untuk kirim pesan teks
- Bisa dikembangkan untuk kirim media, integrasi n8n, dsb.

⚠️ **Disclaimer:**  
Bot ini menggunakan _WhatsApp Web reverse engineering_. Tidak resmi dari WhatsApp.  
Gunakan dengan bijak (jangan spam, jangan untuk komersial ilegal). Ada risiko nomor terblokir.

---

## 🚀 Cara Install & Jalankan (Lokal)

1. Clone repo ini:

   ```bash
   git clone <url-repo>
   cd wa-bot
   ```

2. Install dependency:

   ```bash
   npm ci
   ```

   > gunakan `npm ci` agar sesuai `package-lock.json`.

3. Buat file `.env`:

   ```
   PORT=3000
   SESSION_DIR=./auth
   ```

4. Jalankan:

   ```bash
   npm start
   ```

5. Scan QR yang muncul di terminal melalui **WhatsApp > Perangkat Tertaut > Tautkan Perangkat**.

6. Jika sukses, akan muncul log:
   ```
   WA connected ✅
   ```

---

## 🔄 Auto-Reply

Bot akan otomatis balas pesan dengan beberapa command:

- `ping` → `pong ✅`
- `menu` → daftar perintah
- `info` → info singkat
- `waktu` → jam server
- `id` → tampilkan JID kamu
- `balas <teks>` → membalas sesuai teks
- `foto <url>` → kirim gambar dari URL

Selain itu, pesan lain akan di-_echo_ kembali.

---

## 🌐 REST API

Bot menyediakan REST API sederhana (Express.js).

- **Healthcheck**

  ```
  GET /health
  Response: { "ok": true, "ready": true }
  ```

- **Kirim pesan teks**
  ```
  GET /sendText?to=62812xxxxxx&text=Halo
  ```
  - `to` = nomor tujuan (format MSISDN, ex: `62812...`)
  - `text` = isi pesan
  - contoh hasil: `{ "ok": true }`

---

## 📦 Deploy ke CapRover

1. Pastikan ada file `Dockerfile` & `captain-definition`.
2. Buat app baru di CapRover (mis: `wa-bot`).
3. Tambahkan **persistent volume**:
   - Container path: `/app/auth`
   - Volume name: `wa-bot-auth`
4. Tambahkan **ENV**:
   ```
   PORT=3000
   SESSION_DIR=/app/auth
   ```
5. Deploy dengan `caprover deploy`.
6. Scan QR sekali (bisa dari log atau copy `auth/` lokal ke volume server).

---

## 🔒 Catatan Penting

- Folder `auth/` berisi kredensial WA → **jangan commit ke git**.
- File `.env` berisi config → **jangan commit ke git**.
- Gunakan `.gitignore`:
  ```
  node_modules
  .env
  auth
  ```
- Jalankan hanya **1 instance per nomor WA**. Jangan scale replicas >1.
- Gunakan bot dengan bijak agar nomor tidak di-banned.

---

## 🛠️ Pengembangan Lanjut

- Kirim media (gambar, dokumen, audio) lewat REST.
- Integrasi ke n8n / workflow automation.
- Simpan log chat ke database.
- Tambahkan autentikasi sederhana (API key) pada endpoint REST.

---

## 📜 Lisensi

MIT — bebas dipakai, mohon sertakan atribusi ke repo asli.
