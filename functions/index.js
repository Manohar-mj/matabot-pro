/**
 * Firebase Cloud Functions — MataBot Backend
 * functions/index.js
 *
 * 1. groqProxy      — Secure Groq API proxy (keeps API key server-side)
 * 2. syncFaqsFromSheets — Sync Google Sheets FAQ data into Firestore
 * 3. analyticsReport   — Aggregate analytics (scheduled daily)
 */

const functions  = require('firebase-functions');
const admin      = require('firebase-admin');
const fetch      = require('node-fetch');
const { google } = require('googleapis');

admin.initializeApp();
const db = admin.firestore();

/* ─────────────────────────────────────────
   1. GROQ PROXY — keeps API key server-side
   ───────────────────────────────────────── */
exports.groqProxy = functions
  .runWith({ timeoutSeconds: 60, memory: '256MB' })
  .https.onCall(async (data, context) => {

    // Auth guard
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
    }

    const { messages, sessionId } = data;

    // Input validation
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new functions.https.HttpsError('invalid-argument', 'messages array required.');
    }
    if (messages.length > 40) {
      throw new functions.https.HttpsError('invalid-argument', 'Conversation too long.');
    }
    for (const m of messages) {
      if (!['user','assistant','system'].includes(m.role)) {
        throw new functions.https.HttpsError('invalid-argument', 'Invalid message role.');
      }
      if (typeof m.content !== 'string' || m.content.length > 8000) {
        throw new functions.https.HttpsError('invalid-argument', 'Message content invalid.');
      }
    }

    // Rate limiting — max 30 calls per user per hour via Firestore counter
    const rateRef  = db.collection('rateLimits').doc(context.auth.uid);
    const rateSnap = await rateRef.get();
    const now      = Date.now();
    const hourAgo  = now - 3_600_000;

    if (rateSnap.exists) {
      const { count, windowStart } = rateSnap.data();
      if (windowStart > hourAgo && count >= 30) {
        throw new functions.https.HttpsError('resource-exhausted', 'Rate limit: 30 requests/hour.');
      }
      await rateRef.set({
        count:       windowStart > hourAgo ? count + 1 : 1,
        windowStart: windowStart > hourAgo ? windowStart : now,
      });
    } else {
      await rateRef.set({ count: 1, windowStart: now });
    }

    // Call Groq API
    const groqKey = functions.config().groq.api_key;
    const resp    = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model:       'llama-3.3-70b-versatile',
        messages,
        max_tokens:  1300,
        temperature: 0.70,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      functions.logger.error('Groq API error', err);
      throw new functions.https.HttpsError('internal', 'AI service error. Try again.');
    }

    const result  = await resp.json();
    const content = result.choices?.[0]?.message?.content || '';

    // Log analytics
    if (sessionId) {
      await db.collection('analytics').add({
        event:     'chat_message',
        uid:       context.auth.uid,
        sessionId,
        tokens:    result.usage?.total_tokens || 0,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    return { content };
  });


/* ─────────────────────────────────────────
   2. SYNC FAQs FROM GOOGLE SHEETS
   Triggered via HTTP (call from admin panel or scheduled)
   ───────────────────────────────────────── */
exports.syncFaqsFromSheets = functions
  .runWith({ timeoutSeconds: 120, memory: '256MB' })
  .https.onCall(async (_data, context) => {

    // Only admins (custom claim) can trigger sync
    if (!context.auth || !context.auth.token.admin) {
      throw new functions.https.HttpsError('permission-denied', 'Admin only.');
    }

    const sheetsId = functions.config().sheets.faq_id;
    const auth     = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets   = google.sheets({ version: 'v4', auth });

    const res  = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetsId,
      range:         'FAQs!A2:D',   // columns: question | answer | category | tags
    });

    const rows  = res.data.values || [];
    const batch = db.batch();

    // Clear old FAQs
    const existing = await db.collection('faqs').listDocuments();
    existing.forEach(ref => batch.delete(ref));

    // Write new FAQs
    rows.forEach((row, i) => {
      if (!row[0] || !row[1]) return;
      const ref = db.collection('faqs').doc(`faq_${i}`);
      batch.set(ref, {
        question:  row[0].trim(),
        answer:    row[1].trim(),
        category:  row[2]?.trim() || 'General',
        tags:      row[3] ? row[3].split(',').map(t => t.trim()) : [],
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    await batch.commit();
    functions.logger.info(`Synced ${rows.length} FAQs from Sheets`);
    return { synced: rows.length };
  });


/* ─────────────────────────────────────────
   3. DAILY ANALYTICS AGGREGATION (Scheduled)
   ───────────────────────────────────────── */
exports.dailyAnalytics = functions.pubsub
  .schedule('0 0 * * *')   // midnight IST
  .timeZone('Asia/Kolkata')
  .onRun(async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const today = new Date(yesterday);
    today.setDate(today.getDate() + 1);

    const snap = await db.collection('analytics')
      .where('timestamp', '>=', yesterday)
      .where('timestamp', '<', today)
      .get();

    const totalMessages = snap.size;
    const totalTokens   = snap.docs.reduce((sum, d) => sum + (d.data().tokens || 0), 0);
    const uniqueUsers   = new Set(snap.docs.map(d => d.data().uid)).size;

    await db.collection('dailyStats').doc(yesterday.toISOString().split('T')[0]).set({
      date: yesterday.toISOString().split('T')[0],
      totalMessages,
      totalTokens,
      uniqueUsers,
      computedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    functions.logger.info('Daily stats saved', { totalMessages, totalTokens, uniqueUsers });
  });
