# MY TRACK
**Your Life. Your Progress. Your Track.**

اپلیکیشن شخصی مدیریت درس‌ها، پول‌ها و مهارت‌ها (فارسی، راست‌چین، تک‌کاربره).

**فناوری:** HTML/CSS/JS · Node.js + Express · PostgreSQL (Neon) · Chart.js

## ساختار
```
server.js          سرور و API
db.js              اتصال به PostgreSQL و ساخت خودکار جدول‌ها
db/schema.sql      ساخت جدول‌ها (settings, subjects, study_records, transactions, skills, skill_steps)
db/init.js         اجرای دستی schema  →  npm run db:init
public/            فرانت‌اند (index.html, css/, js/, assets/mytrack-bg.jpg)
```
سرور هنگام شروع، جدول‌ها را (اگر نباشند) خودکار می‌سازد.

## ۱) ساخت دیتابیس Neon
1. در [neon.tech](https://neon.tech) یک Project بسازید.
2. از بخش **Connection string** مقدار `postgresql://...` را کپی کنید (این همان `DATABASE_URL` است).

## ۲) اجرای محلی
```bash
npm install
cp .env.example .env     # در ویندوز: copy .env.example .env
```
فایل `.env` را باز کنید و این‌ها را پر کنید:
- `DATABASE_URL` : آدرس Neon
- `APP_USERNAME` و `APP_PASSWORD` : ورود شخصی شما
- `SESSION_SECRET` : یک رشته‌ی تصادفی طولانی (`openssl rand -hex 32`)

```bash
npm start
```
سپس `http://localhost:3000` را باز کنید.

## ۳) انتشار در GitHub
```bash
git init
git add .
git commit -m "MY TRACK v1"
git branch -M main
git remote add origin https://github.com/USERNAME/my-track.git
git push -u origin main
```
فایل `.env` در `.gitignore` است و آپلود نمی‌شود. مخزن را **Private** بسازید.

## ۴) انتشار در Render
1. Render → **New → Web Service** → مخزن GitHub را انتخاب کنید.
2. تنظیمات: Runtime = `Node` · Build Command = `npm install` · Start Command = `npm start`
3. در **Environment** این متغیرها را اضافه کنید: `DATABASE_URL`, `APP_USERNAME`, `APP_PASSWORD`, `SESSION_SECRET`, `NODE_ENV=production`
4. Deploy بزنید. پورت خودکار از `process.env.PORT` خوانده می‌شود.

## نکته‌ها
- واحد پول در فرانت‌اند «تومان» است؛ برای تغییر، تابع `money` در `public/js/app.js` را ویرایش کنید.
- نمودارها از CDN بارگذاری می‌شوند (به اینترنت نیاز دارد).
- نشست ورود ۷ روز اعتبار دارد و پس از ۸ تلاش ناموفق، ورود به‌طور موقت مسدود می‌شود.
- برای افزودن امکانات آینده (عادت‌ها، تایمر، اهداف و…): یک جدول در `db/schema.sql`، چند مسیر در `server.js`، و یک ورودی در `VIEWS` و `RENDER` فایل `app.js` اضافه کنید.
