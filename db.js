const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// تاریخ‌ها به‌صورت رشته‌ی YYYY-MM-DD و اعداد به‌صورت number برگردند
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1700, (v) => parseFloat(v));
types.setTypeParser(20, (v) => parseInt(v, 10));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL تنظیم نشده است (فایل .env یا Environment در Render).');
  process.exit(1);
}

const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: local ? false : { rejectUnauthorized: false },
  max: 5,
});

async function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = { pool, initSchema };
