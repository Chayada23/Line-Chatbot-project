// index.js — Line Bot with Express + MySQL + Google Sheets
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const mysql = require('mysql2/promise');
const { google } = require('googleapis');

// ─── Config ───────────────────────────────────────────────
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const PORT = process.env.PORT || 3000;

const DB_CONFIG = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
};

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Sheet1';

// ─── Google Sheets Auth (Service Account) ─────────────────
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_PATH,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// ─── Express App ──────────────────────────────────────────
const app = express();

// เก็บ rawBody ไว้ verify signature ของ LINE
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ─── Helpers ──────────────────────────────────────────────

function validateSignature(rawBody, signature) {
  const hash = crypto
    .createHmac('sha256', LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest('base64');
  return hash === signature;
}

async function replyMessage(replyToken, messages) {
  await axios.post(
    'https://api.line.me/v2/bot/message/reply',
    { replyToken, messages },
    {
      headers: {
        Authorization: `Bearer ${LINE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

// ─── Google Sheets: append แถวใหม่ ────────────────────────
async function appendToSheet(row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SHEET_NAME}'!A1`,  // ← เพิ่ม ' ครอบ
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

// ─── Flex Messages ────────────────────────────────────────

function consentFlex() {
  return {
    type: 'flex',
    altText: 'โปรดเลือกการยินยอม',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: 'คุณยินยอมเข้าร่วมแบบสอบถามไหมคะ?',
            weight: 'bold',
            size: 'md',
          },
          {
            type: 'button',
            action: { type: 'message', label: '✅ ยินยอม', text: 'ยินยอม' },
            style: 'primary',
            color: '#28a745',
          },
          {
            type: 'button',
            action: { type: 'message', label: '❌ ไม่ยินยอม', text: 'ไม่ยินยอม' },
            style: 'secondary',
          },
        ],
      },
    },
  };
}

function locationFlex() {
  const places = ['บ้าน', 'ตลาด', 'มหาวิทยาลัย', 'ใกล้สนามบิน'];
  return {
    type: 'flex',
    altText: 'เลือกสถานที่',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: 'คุณอยู่ที่สถานที่ใดคะ?',
            weight: 'bold',
            size: 'md',
          },
          ...places.map((p) => ({
            type: 'button',
            action: { type: 'message', label: p, text: p },
            style: 'secondary',
          })),
        ],
      },
    },
  };
}

function noiseLevelFlex() {
  const levels = ['ไม่รบกวนเลย', 'รบกวนเล็กน้อย', 'รบกวนมาก'];
  return {
    type: 'flex',
    altText: 'เลือกระดับเสียง',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: 'ระดับความรบกวนของเสียง?',
            weight: 'bold',
            size: 'md',
          },
          ...levels.map((l) => ({
            type: 'button',
            action: { type: 'message', label: l, text: l },
            style: 'secondary',
          })),
        ],
      },
    },
  };
}

// ─── Event Handler ────────────────────────────────────────

async function handleEvent(ev, conn) {
  const replyToken = ev.replyToken;
  const userId = ev.source.userId;

  // 🧩 Follow event — เพิ่มเพื่อน
  if (ev.type === 'follow') {
    await conn.execute(
      'INSERT IGNORE INTO users (user_id, step) VALUES (?, ?)',
      [userId, -1]
    );
    await replyMessage(replyToken, [consentFlex()]);
    return;
  }

  // ดึงข้อมูลผู้ใช้จาก MySQL
  const [userRows] = await conn.execute(
    'SELECT * FROM users WHERE user_id=?',
    [userId]
  );
  const user = userRows[0];

  // 🗣 Text message
  if (ev.type === 'message' && ev.message.type === 'text') {
    const text = ev.message.text.trim();

    // เริ่มแบบสอบถามใหม่
    if (text === 'เริ่มแบบสอบถามใหม่') {
      await conn.execute(
        `UPDATE users
         SET step=-1, consent=NULL, place=NULL, noise_level=NULL,
             latitude=NULL, longitude=NULL, address=NULL
         WHERE user_id=?`,
        [userId]
      );
      await replyMessage(replyToken, [
        { type: 'text', text: 'เริ่มทำแบบสอบถามใหม่อีกครั้งค่ะ 🔄' },
        consentFlex(),
      ]);
      return;
    }

    if (text === 'ยินยอม') {
      await conn.execute(
        'UPDATE users SET consent=?, step=? WHERE user_id=?',
        ['ยินยอม', 1, userId]
      );
      await replyMessage(replyToken, [locationFlex()]);

    } else if (text === 'ไม่ยินยอม') {
      await conn.execute(
        'UPDATE users SET consent=?, step=? WHERE user_id=?',
        ['ไม่ยินยอม', -1, userId]
      );
      await replyMessage(replyToken, [
        { type: 'text', text: 'ขอบคุณค่ะ ข้อมูลของคุณจะไม่ถูกบันทึก 🙏' },
      ]);

    } else if (
      user?.step === 1 &&
      ['บ้าน', 'ตลาด', 'มหาวิทยาลัย', 'ใกล้สนามบิน'].includes(text)
    ) {
      await conn.execute(
        'UPDATE users SET place=?, step=? WHERE user_id=?',
        [text, 2, userId]
      );
      await replyMessage(replyToken, [noiseLevelFlex()]);

    } else if (
      user?.step === 2 &&
      ['ไม่รบกวนเลย', 'รบกวนเล็กน้อย', 'รบกวนมาก'].includes(text)
    ) {
      await conn.execute(
        'UPDATE users SET noise_level=?, step=? WHERE user_id=?',
        [text, 3, userId]
      );
      await replyMessage(replyToken, [
        { type: 'text', text: 'กรุณาส่งตำแหน่งที่อยู่ของคุณค่ะ 🌍' },
      ]);
    }
  }

  // 📍 Location message (step 3) — บันทึก MySQL แล้ว sync ไป Google Sheets
  if (ev.type === 'message' && ev.message.type === 'location') {
    const { latitude, longitude, address } = ev.message;

    // บันทึกลง MySQL
    await conn.execute(
      'UPDATE users SET latitude=?, longitude=?, address=?, step=? WHERE user_id=?',
      [latitude, longitude, address, 0, userId]
    );

    // ดึงข้อมูลครบแล้ว sync ไป Google Sheets
    const [rows] = await conn.execute(
      'SELECT * FROM users WHERE user_id=?',
      [userId]
    );
    const record = rows[0];

    if (record) {
      await appendToSheet([
        record.user_id,
        record.consent,
        record.place || '',
        record.noise_level || '',
        latitude,
        longitude,
        address || '',
        new Date().toISOString(),
      ]);
    }

    await replyMessage(replyToken, [
      { type: 'text', text: 'ขอบคุณค่ะ ข้อมูลของคุณถูกบันทึกเรียบร้อยแล้ว 🙏' },
    ]);
  }
}

app.post('/webhook', async (req, res) => {
  const signature =
    req.headers['x-line-signature'] || req.headers['X-Line-Signature'];

  if (!validateSignature(req.rawBody, signature)) {
    return res.status(401).send('Invalid signature');
  }

  // log payload
  console.log(JSON.stringify(req.body, null, 2));

  const events = req.body.events || [];

  if (events.length === 0) {
    return res.status(200).json({ status: 'no events' });
  }

  let conn;

  try {
    conn = await mysql.createConnection(DB_CONFIG);

    await Promise.all(
      events.map((ev) => handleEvent(ev, conn))
    );

    return res.status(200).json({ status: 'ok' });

  } catch (err) {
    console.error('❌ Error:', err);
    return res.status(500).send('Server Error');

  } finally {
    if (conn) await conn.end();
  }
});

// Health check
app.get('/', (_req, res) => res.send('✅ Line Bot is running'));

// ─── Start Server ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Bot running on port ${PORT}`);
});