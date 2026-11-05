require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { pool, initSchema } = require('./db');

const { APP_PASSWORD, SESSION_SECRET } = process.env;
const APP_USERNAME = process.env.APP_USERNAME || 'admin';
if (!APP_PASSWORD || !SESSION_SECRET) {
  console.error('APP_PASSWORD و SESSION_SECRET باید تنظیم شوند.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- احراز هویت (تک‌کاربره) ---------- */
const COOKIE = 'mt_session';
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function makeToken() {
  const exp = String(Date.now() + 7 * 24 * 3600 * 1000);
  return `${exp}.${sign(exp)}`;
}
function validToken(t) {
  if (!t) return false;
  const [exp, sig] = t.split('.');
  if (!exp || !sig) return false;
  const expected = sign(exp);
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) && Number(exp) > Date.now();
}
function getCookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
const cookieFlags = () => `HttpOnly; SameSite=Lax; Path=/${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;

const attempts = new Map();
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: 'خطای سرور. دوباره تلاش کنید.' });
  });
const bad = (res, msg) => res.status(400).json({ error: msg });

app.get('/api/me', (req, res) => res.json({ authenticated: validToken(getCookie(req, COOKIE)) }));

app.post('/api/login', (req, res) => {
  const rec = attempts.get(req.ip) || { n: 0, t: Date.now() };
  if (Date.now() - rec.t > 15 * 60 * 1000) { rec.n = 0; rec.t = Date.now(); }
  if (rec.n >= 8) return res.status(429).json({ error: 'تلاش‌های ناموفق زیاد بود. چند دقیقه بعد دوباره امتحان کنید.' });
  const { username = '', password = '' } = req.body || {};
  if (safeEq(username, APP_USERNAME) && safeEq(password, APP_PASSWORD)) {
    attempts.delete(req.ip);
    res.set('Set-Cookie', `${COOKIE}=${makeToken()}; Max-Age=${7 * 24 * 3600}; ${cookieFlags()}`);
    return res.json({ ok: true });
  }
  rec.n++; attempts.set(req.ip, rec);
  res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است.' });
});

app.post('/api/logout', (req, res) => {
  res.set('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieFlags()}`);
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  if (validToken(getCookie(req, COOKIE))) return next();
  res.status(401).json({ error: 'ابتدا وارد شوید.' });
});

/* ---------- ابزارهای اعتبارسنجی ---------- */
const s = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const today = () => new Date().toISOString().slice(0, 10);

/* ---------- تنظیمات و وضعیت دیتابیس ---------- */
app.get('/api/health', wrap(async (req, res) => {
  const t0 = Date.now();
  await pool.query('SELECT 1');
  res.json({ db: true, ms: Date.now() - t0 });
}));

app.get('/api/settings', wrap(async (req, res) => {
  const r = await pool.query(`SELECT value FROM settings WHERE key='theme'`);
  res.json({ theme: r.rows[0]?.value || 'dark' });
}));

app.put('/api/settings', wrap(async (req, res) => {
  const theme = req.body?.theme;
  if (!['light', 'dark'].includes(theme)) return bad(res, 'تم نامعتبر است.');
  await pool.query(`INSERT INTO settings(key,value) VALUES('theme',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [theme]);
  res.json({ theme });
}));

/* ---------- درس‌ها ---------- */
function subjectData(b) {
  const title = s(b.title, 200);
  if (!title) return { error: 'عنوان درس الزامی است.' };
  const status = b.status === 'done' ? 'done' : 'todo';
  return { v: [title, s(b.source, 200), s(b.chapter, 200), s(b.topic, 200), dateOrNull(b.study_date), s(b.notes), status] };
}
async function logStudy(id, status) {
  await pool.query('INSERT INTO study_records(subject_id,status) VALUES($1,$2)', [id, status]);
}

app.get('/api/subjects', wrap(async (req, res) => {
  const r = await pool.query('SELECT * FROM subjects ORDER BY study_date DESC NULLS LAST, id DESC');
  res.json(r.rows);
}));

app.post('/api/subjects', wrap(async (req, res) => {
  const d = subjectData(req.body || {});
  if (d.error) return bad(res, d.error);
  const r = await pool.query(
    'INSERT INTO subjects(title,source,chapter,topic,study_date,notes,status) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', d.v);
  if (r.rows[0].status === 'done') await logStudy(r.rows[0].id, 'done');
  res.status(201).json(r.rows[0]);
}));

app.put('/api/subjects/:id', wrap(async (req, res) => {
  const d = subjectData(req.body || {});
  if (d.error) return bad(res, d.error);
  const old = await pool.query('SELECT status FROM subjects WHERE id=$1', [req.params.id]);
  if (!old.rowCount) return res.status(404).json({ error: 'درس پیدا نشد.' });
  const r = await pool.query(
    'UPDATE subjects SET title=$1,source=$2,chapter=$3,topic=$4,study_date=$5,notes=$6,status=$7 WHERE id=$8 RETURNING *',
    [...d.v, req.params.id]);
  if (old.rows[0].status !== r.rows[0].status) await logStudy(r.rows[0].id, r.rows[0].status);
  res.json(r.rows[0]);
}));

app.patch('/api/subjects/:id/status', wrap(async (req, res) => {
  const status = req.body?.status === 'done' ? 'done' : 'todo';
  const r = await pool.query('UPDATE subjects SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'درس پیدا نشد.' });
  await logStudy(r.rows[0].id, status);
  res.json(r.rows[0]);
}));

app.delete('/api/subjects/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM subjects WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

/* ---------- پول‌ها ---------- */
function txData(b) {
  const title = s(b.title, 200);
  const amount = Number(b.amount);
  if (!title) return { error: 'عنوان تراکنش الزامی است.' };
  if (!['income', 'expense'].includes(b.type)) return { error: 'نوع تراکنش نامعتبر است.' };
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'مبلغ باید عددی بزرگ‌تر از صفر باشد.' };
  return { v: [b.type, title, amount, s(b.category, 100), dateOrNull(b.tx_date) || today(), s(b.notes)] };
}

async function moneySummary() {
  const tot = await pool.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE type='income'),0) AS income,
            COALESCE(SUM(amount) FILTER (WHERE type='expense'),0) AS expense FROM transactions`);
  const month = await pool.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE type='income'),0) AS income,
            COALESCE(SUM(amount) FILTER (WHERE type='expense'),0) AS expense
     FROM transactions WHERE date_trunc('month',tx_date)=date_trunc('month',CURRENT_DATE)`);
  const mon = await pool.query(
    `SELECT to_char(date_trunc('month',tx_date),'YYYY-MM') AS m, type, SUM(amount) AS total
     FROM transactions WHERE tx_date >= date_trunc('month',CURRENT_DATE) - interval '5 months'
     GROUP BY 1,2`);
  const now = new Date();
  const monthly = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    monthly.push({
      month: key,
      income: mon.rows.find((x) => x.m === key && x.type === 'income')?.total || 0,
      expense: mon.rows.find((x) => x.m === key && x.type === 'expense')?.total || 0,
    });
  }
  const { income, expense } = tot.rows[0];
  return { income, expense, balance: income - expense, month: month.rows[0], monthly };
}

app.get('/api/transactions', wrap(async (req, res) => {
  const r = await pool.query('SELECT * FROM transactions ORDER BY tx_date DESC, id DESC');
  res.json(r.rows);
}));
app.get('/api/money/summary', wrap(async (req, res) => res.json(await moneySummary())));

app.post('/api/transactions', wrap(async (req, res) => {
  const d = txData(req.body || {});
  if (d.error) return bad(res, d.error);
  const r = await pool.query(
    'INSERT INTO transactions(type,title,amount,category,tx_date,notes) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', d.v);
  res.status(201).json(r.rows[0]);
}));
app.put('/api/transactions/:id', wrap(async (req, res) => {
  const d = txData(req.body || {});
  if (d.error) return bad(res, d.error);
  const r = await pool.query(
    'UPDATE transactions SET type=$1,title=$2,amount=$3,category=$4,tx_date=$5,notes=$6 WHERE id=$7 RETURNING *',
    [...d.v, req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'تراکنش پیدا نشد.' });
  res.json(r.rows[0]);
}));
app.delete('/api/transactions/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM transactions WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

/* ---------- مهارت‌ها ---------- */
const SKILL_STATUS = ['not_started', 'learning', 'completed'];

async function listSkills() {
  const sk = await pool.query('SELECT * FROM skills ORDER BY id DESC');
  const st = await pool.query('SELECT id,skill_id,title,done FROM skill_steps ORDER BY position, id');
  return sk.rows.map((k) => {
    const steps = st.rows.filter((x) => x.skill_id === k.id);
    const done = steps.filter((x) => x.done).length;
    const progress = steps.length ? Math.round((done / steps.length) * 100) : k.status === 'completed' ? 100 : 0;
    return { ...k, steps, progress };
  });
}

// وضعیت را با پیشرفت مراحل هماهنگ نگه می‌دارد
async function autoStatus(db, id) {
  const r = await db.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE done) AS done FROM skill_steps WHERE skill_id=$1`, [id]);
  const { total, done } = r.rows[0];
  if (!total) return;
  const status = done === total ? 'completed' : done > 0 ? 'learning' : null;
  if (status) await db.query('UPDATE skills SET status=$1 WHERE id=$2', [status, id]);
  else await db.query(`UPDATE skills SET status='not_started' WHERE id=$1 AND status='completed'`, [id]);
}

function skillData(b) {
  const title = s(b.title, 200);
  if (!title) return { error: 'عنوان مهارت الزامی است.' };
  const link = s(b.link, 500);
  if (link && !/^https?:\/\//i.test(link)) return { error: 'لینک باید با http:// یا https:// شروع شود.' };
  const status = SKILL_STATUS.includes(b.status) ? b.status : 'not_started';
  const steps = (Array.isArray(b.steps) ? b.steps : []).slice(0, 100)
    .map((x) => ({ title: s(x.title, 300), done: !!x.done })).filter((x) => x.title);
  return { v: [title, s(b.description), s(b.resources), link, s(b.notes), status], steps };
}

async function saveSteps(client, id, steps) {
  await client.query('DELETE FROM skill_steps WHERE skill_id=$1', [id]);
  for (let i = 0; i < steps.length; i++) {
    await client.query('INSERT INTO skill_steps(skill_id,title,done,position) VALUES($1,$2,$3,$4)', [id, steps[i].title, steps[i].done, i]);
  }
  await autoStatus(client, id);
}

async function withTx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

app.get('/api/skills', wrap(async (req, res) => res.json(await listSkills())));

app.post('/api/skills', wrap(async (req, res) => {
  const d = skillData(req.body || {});
  if (d.error) return bad(res, d.error);
  await withTx(async (c) => {
    const r = await c.query('INSERT INTO skills(title,description,resources,link,notes,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', d.v);
    await saveSteps(c, r.rows[0].id, d.steps);
  });
  res.status(201).json({ ok: true });
}));

app.put('/api/skills/:id', wrap(async (req, res) => {
  const d = skillData(req.body || {});
  if (d.error) return bad(res, d.error);
  const ok = await withTx(async (c) => {
    const r = await c.query('UPDATE skills SET title=$1,description=$2,resources=$3,link=$4,notes=$5,status=$6 WHERE id=$7 RETURNING id', [...d.v, req.params.id]);
    if (!r.rowCount) return false;
    await saveSteps(c, r.rows[0].id, d.steps);
    return true;
  });
  if (!ok) return res.status(404).json({ error: 'مهارت پیدا نشد.' });
  res.json({ ok: true });
}));

app.patch('/api/skills/:id/steps/:stepId', wrap(async (req, res) => {
  const r = await pool.query('UPDATE skill_steps SET done=$1 WHERE id=$2 AND skill_id=$3', [!!req.body?.done, req.params.stepId, req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'مرحله پیدا نشد.' });
  await autoStatus(pool, req.params.id);
  res.json({ ok: true });
}));

app.delete('/api/skills/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM skills WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

/* ---------- داشبورد ---------- */
app.get('/api/dashboard', wrap(async (req, res) => {
  const sub = await pool.query(`SELECT COUNT(*) FILTER (WHERE status='done') AS done, COUNT(*) FILTER (WHERE status='todo') AS todo FROM subjects`);
  const money = await moneySummary();
  const skills = (await listSkills()).filter((k) => k.status === 'learning');
  const act = await pool.query(
    `(SELECT 'study' AS kind, s.title, r.status AS info, r.recorded_at AS happened FROM study_records r JOIN subjects s ON s.id=r.subject_id)
     UNION ALL (SELECT 'tx', title, type || ':' || amount::text, created_at FROM transactions)
     UNION ALL (SELECT 'skill', title, status, created_at FROM skills)
     ORDER BY happened DESC LIMIT 8`);
  res.json({ subjects: sub.rows[0], money, skills, activity: act.rows });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'مسیر پیدا نشد.' }));

const PORT = process.env.PORT || 3000;
initSchema()
  .then(() => app.listen(PORT, () => console.log(`MY TRACK روی پورت ${PORT} اجرا شد.`)))
  .catch((e) => { console.error('اتصال به دیتابیس ناموفق بود:', e.message); process.exit(1); });
