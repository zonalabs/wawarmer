Jalankan node js di localhost pc kalau di android gunakan termux file nya bernama zip perlu di extract 
karena di upload di web agak sulit
kalau sudah di extract hapus 
hapus file package-lock.json dulu terus npm install

pkg update && pkg upgrade
pkg install unzip
termux-setup-storage

cd /sdcard/Download

unzip "whatsapp group warming.zip"

pkg install nodejs

npm install

npm start

klau done succes masuk browser
http://127.0.0.1:3000
http://localhost:3000
