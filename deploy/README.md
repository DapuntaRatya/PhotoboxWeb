# Deployment pada VPS bersama

| Proyek | Path publik | Port HTTP internal | Checkout | Data privat |
| --- | --- | --- | --- | --- |
| PhotoboxWeb | `/photobox/` | `127.0.0.1:8787` | `/opt/photoboxweb` | `/var/lib/photoboxweb` |
| Project 2 (alokasi) | `/project_2/` | `127.0.0.1:8788` | `/opt/project_2` | `/var/lib/project_2` |
| Project 3 (alokasi) | `/project_3/` | `127.0.0.1:8789` | `/opt/project_3` | `/var/lib/project_3` |

Nginx memakai TCP 80 dan 443. Coturn PhotoboxWeb memakai TCP/UDP 3478 dan UDP 49160–49259. Siapkan pemetaan port publik ke VPS jika penyedia menggunakan NAT. Backend aplikasi mendengarkan pada loopback. Akun systemd, data, dan konfigurasi runtime tiap proyek memiliki lokasi sendiri.

## Update PhotoboxWeb

Masuk ke VPS dengan `ssh photobox-vps`. Jalankan setelah perubahan masuk ke branch `main`.

```sh
cd /opt/photoboxweb
git pull --ff-only origin main
npm ci
PHOTOBOX_BASE_PATH=/photobox/ npm run build
sudo systemctl restart photobox.service
curl -fsS https://203.145.34.157/photobox/api/time
```

Restart layanan memutus koneksi WebSocket yang aktif sesaat. Build dan restart ini hanya menyentuh PhotoboxWeb. Konfigurasi aktif berada di `/etc`. SQLite dan ekspor berada di `/var/lib/photoboxweb`.

## Tambah proyek

1. Siapkan checkout, user layanan, unit systemd, dan port loopback untuk proyek baru.
2. Atur base path proyek sesuai rute publiknya, termasuk URL aset dan API. Buat satu file rute dan satu file redirect milik proyek tersebut.

   `/etc/nginx/project-routes/project_2.conf`

   ```nginx
   location = /project_2 {
       return 308 /project_2/$is_args$args;
   }
   location ^~ /project_2/ {
       proxy_pass http://127.0.0.1:8788/;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```

   `/etc/nginx/project-redirects/project_2.conf`

   ```nginx
   location ~ ^/project_2(?:/|$) {
       return 308 https://$host$request_uri;
   }
   ```

   Contoh tersebut menghapus awalan `/project_2/` saat meneruskan request ke backend. Untuk backend yang menangani awalan itu sendiri, hapus garis miring setelah `:8788` pada `proxy_pass`. Tambahkan header Upgrade dan Connection pada rute WebSocket jika proyek membutuhkannya.
3. Jalankan `sudo nginx -t && sudo systemctl reload nginx`, kemudian cek rute baru dan rute PhotoboxWeb. HTTPS berlaku untuk semua path di host yang sudah bersertifikat. Aplikasi yang berbagi nama host juga berbagi origin browser. Gunakan host terpisah untuk proyek yang memerlukan pemisahan akses browser.

## Instalasi pertama

1. Pasang Nginx, Node.js yang memenuhi engine dependensi, npm, coturn, dan Certbot 5.4+. Siapkan user sistem `photobox`. Clone branch `main` ke `/opt/photoboxweb` dengan kepemilikan akun deploy. Bangun frontend dengan `PHOTOBOX_BASE_PATH=/photobox/ npm run build` setelah `npm ci`.
2. Buat `/etc/nginx/project-routes`, `/etc/nginx/project-redirects`, dan `/var/www/acme`. Nonaktifkan situs default bawaan jika instalasi baru. Untuk penerbitan pertama, aktifkan hanya blok port 80 dari [nginx.conf](nginx.conf) dan ganti `VPS_PUBLIC_IP` dengan IPv4 publik. Jalankan `sudo nginx -t && sudo systemctl reload nginx`.
3. Terbitkan sertifikat IP dengan `sudo certbot certonly --webroot -w /var/www/acme --preferred-profile shortlived --ip-address IP_PUBLIK`. Gunakan Certbot dari paket yang sesuai. Pasang dua blok server lengkap dan file rute, redirect, serta header sesuai komentar penempatan dalam berkas [konfigurasi Nginx](nginx.conf), [rute](photobox.nginx.conf), [redirect](photobox.nginx-redirect.conf), dan [header](photobox.nginx-headers.conf). Aktifkan timer Certbot dan tambahkan deploy hook yang menjalankan `nginx -t && systemctl reload nginx` setelah pembaruan sertifikat. Uji dengan `certbot renew --dry-run`.
4. Pasang [contoh environment](photobox.env.example) di `/etc/photoboxweb.env` dengan izin `0600`. Isi origin HTTPS tanpa path dan secret TURN acak. Isikan secret yang sama serta alamat publik dan privat yang sesuai di [konfigurasi coturn](turnserver.conf), lalu pasang sebagai `/etc/turnserver.conf` dengan akses baca untuk user layanan coturn.
5. Salin unit `photobox*.service` dan `photobox-cleanup.timer` ke `/etc/systemd/system/`. Jalankan `sudo systemctl daemon-reload`, aktifkan `nginx`, `coturn`, `photobox.service`, dan `photobox-cleanup.timer`. Uji endpoint `/photobox/api/time` melalui HTTPS dan jalankan tes browser terhadap `/photobox`.

## Tambah domain

Arahkan DNS domain ke VPS, terbitkan sertifikat yang mencakup nama domain tersebut, dan tambahkan virtual host Nginx yang memakai direktori rute yang sama. Untuk apex dan wildcard, cantumkan keduanya dalam sertifikat dan verifikasi wildcard lewat DNS-01. Jika PhotoboxWeb harus berfungsi sekaligus pada beberapa host, tambahkan origin setiap host ke `PHOTOBOX_ORIGIN` sebagai daftar dipisahkan koma. Tautan undangan dibuat dari host tempat room dibuka.
