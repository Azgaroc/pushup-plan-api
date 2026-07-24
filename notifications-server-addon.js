// notifications-server-addon.js
// ---------------------------------------------------------------------------
// À AJOUTER À TON SERVEUR EXISTANT (pushup-plan-api sur Render), à côté de la
// route /api/plan/generate. Ne remplace rien : ce fichier exporte un routeur
// Express + une fonction pour démarrer la tâche planifiée.
//
// Gère DEUX canaux d'envoi :
//   - Web Push (VAPID) pour les utilisateurs du navigateur (Chrome, Safari...)
//   - Firebase Cloud Messaging (FCM) pour les utilisateurs de l'APK Android
//
// Installation (dans le dossier de ton serveur) :
//   npm install web-push node-cron firebase-admin
//
// Génération des clés VAPID (une seule fois, pour le canal navigateur) :
//   npx web-push generate-vapid-keys
// -> copie la clé PUBLIQUE dans PUSH_VAPID_PUBLIC_KEY côté front (le .html)
// -> mets la clé PRIVÉE + PUBLIQUE dans les variables d'environnement Render :
//      VAPID_PUBLIC_KEY=...
//      VAPID_PRIVATE_KEY=...
//      VAPID_SUBJECT=mailto:ton-email@exemple.com
//
// Pour le canal FCM (APK), dans la console Firebase → Paramètres du projet →
// Comptes de service → "Générer une nouvelle clé privée" : télécharge le JSON,
// puis colle TOUT son contenu (sur une seule ligne) dans une variable
// d'environnement Render nommée FIREBASE_SERVICE_ACCOUNT_JSON.
//
// Dans ton fichier serveur principal (ex: pushup-backend-nodejs-free.js) :
//
//   const notifications = require('./notifications-server-addon');
//   app.use(notifications.router);
//   notifications.startScheduler();
//
// ---------------------------------------------------------------------------

const express = require('express');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const cron = require('node-cron');
const admin = require('firebase-admin');

const router = express.Router();

// --- Configuration VAPID (canal navigateur) ---------------------------------
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contact@example.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('[notifications] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY manquantes : le canal navigateur ne pourra pas envoyer de notifications.');
}

// --- Configuration Firebase (canal APK) --------------------------------------
let fcmReady = false;
try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    fcmReady = true;
  } else {
    console.warn('[notifications] FIREBASE_SERVICE_ACCOUNT_JSON manquante : le canal APK (FCM) ne pourra pas envoyer de notifications.');
  }
} catch (e) {
  console.error('[notifications] Erreur d\'initialisation Firebase:', e.message);
}

// --- Stockage -----------------------------------------------------------
// Stockage fichier JSON simple, suffisant pour démarrer. ATTENTION : sur
// Render, le disque n'est pas garanti persistant entre les déploiements
// (plan gratuit). Pour un usage en production avec plusieurs utilisateurs,
// remplace loadStore()/saveStore() par une vraie base de données (ex:
// Postgres, Redis, ou un fichier sur un disque persistant Render).
const STORE_PATH = path.join(__dirname, 'push-subscriptions.json');
const FCM_STORE_PATH = path.join(__dirname, 'push-fcm-tokens.json');

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return {};
  }
}
function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}
const loadStore = () => loadJson(STORE_PATH);
const saveStore = (s) => saveJson(STORE_PATH, s);
const loadFcmStore = () => loadJson(FCM_STORE_PATH);
const saveFcmStore = (s) => saveJson(FCM_STORE_PATH, s);

// --- Endpoints : canal navigateur (Web Push) ---------------------------------
// Enregistre ou met à jour un abonnement (upsert par endpoint de la subscription)
router.post('/api/notifications/subscribe', (req, res) => {
  const { subscription, time, timezone, days, lang } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'subscription manquante ou invalide' });
  }
  const store = loadStore();
  const existing = store[subscription.endpoint] || {};
  store[subscription.endpoint] = {
    subscription,
    time: time || '08:00',
    timezone: timezone || 'UTC',
    days: Array.isArray(days) ? days : [],
    lang: lang || 'fr',
    lastSentDate: existing.lastSentDate || null
  };
  saveStore(store);
  res.json({ ok: true });
});

router.post('/api/notifications/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint manquant' });
  const store = loadStore();
  delete store[endpoint];
  saveStore(store);
  res.json({ ok: true });
});

// --- Endpoints : canal APK (Firebase Cloud Messaging) -------------------------
router.post('/api/notifications/subscribe-fcm', (req, res) => {
  const { token, time, timezone, days, lang } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token manquant' });
  const store = loadFcmStore();
  const existing = store[token] || {};
  store[token] = {
    token,
    time: time || '08:00',
    timezone: timezone || 'UTC',
    days: Array.isArray(days) ? days : [],
    lang: lang || 'fr',
    lastSentDate: existing.lastSentDate || null
  };
  saveFcmStore(store);
  res.json({ ok: true });
});

router.post('/api/notifications/unsubscribe-fcm', (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token manquant' });
  const store = loadFcmStore();
  delete store[token];
  saveFcmStore(store);
  res.json({ ok: true });
});

// --- Diagnostic (temporaire) --------------------------------------------------
// Ouvre https://<ton-serveur>/api/notifications/debug-status dans un navigateur
// pour vérifier rapidement l'état du serveur, sans avoir besoin des logs Render.
router.get('/api/notifications/debug-status', (req, res) => {
  const webPushStore = loadStore();
  const fcmStore = loadFcmStore();
  res.json({
    vapidConfigured: !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY),
    fcmReady,
    webPushSubscriptionsCount: Object.keys(webPushStore).length,
    fcmTokensCount: Object.keys(fcmStore).length,
    fcmEntries: Object.values(fcmStore).map(e => ({ time: e.time, timezone: e.timezone, days: e.days, lang: e.lang, lastSentDate: e.lastSentDate })),
    webPushEntries: Object.values(webPushStore).map(e => ({ time: e.time, timezone: e.timezone, days: e.days, lang: e.lang, lastSentDate: e.lastSentDate }))
  });
});

// --- Contenu de la notification (par langue) --------------------------------
const MESSAGES = {
  fr: { title: 'Push-Up', body: "C'est ton jour d'entraînement ! Prêt pour ta séance ?" },
  en: { title: 'Push-Up', body: "It's your workout day! Ready for your session?" },
  es: { title: 'Push-Up', body: '¡Hoy toca entrenar! ¿Listo para tu sesión?' }
};

function isDueNow(entry, now) {
  const localTimeStr = now.toLocaleTimeString('fr-FR', {
    timeZone: entry.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }); // "HH:MM"
  const localDow = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: entry.timezone, weekday: 'numeric' }).format(now)
  ) % 7; // 0=dimanche ... 6=samedi, comme JS Date.getDay()
  return entry.days.includes(localDow) && localTimeStr === entry.time;
}

// --- Tâche planifiée --------------------------------------------------------
// Vérifie chaque minute, sur les deux canaux, si un abonné doit recevoir sa
// notification : jour de la semaine (dans son fuseau horaire) présent dans
// ses jours d'entraînement, ET heure locale correspondant à l'heure choisie.
function startScheduler() {
  cron.schedule('* * * * *', async () => {
    const todayKey = new Date().toISOString().slice(0, 10); // sert à éviter les doublons
    const now = new Date();

    // Canal navigateur (Web Push)
    const store = loadStore();
    let storeChanged = false;
    for (const [endpoint, entry] of Object.entries(store)) {
      try {
        const alreadySentToday = entry.lastSentDate === todayKey;
        if (isDueNow(entry, now) && !alreadySentToday) {
          const msg = MESSAGES[entry.lang] || MESSAGES.fr;
          await webpush.sendNotification(entry.subscription, JSON.stringify(msg));
          entry.lastSentDate = todayKey;
          storeChanged = true;
        }
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          delete store[endpoint];
          storeChanged = true;
        } else {
          console.error('[notifications] Erreur envoi web push:', err.message);
        }
      }
    }
    if (storeChanged) saveStore(store);

    // Canal APK (FCM)
    if (fcmReady) {
      const fcmStore = loadFcmStore();
      let fcmChanged = false;
      for (const [token, entry] of Object.entries(fcmStore)) {
        try {
          const alreadySentToday = entry.lastSentDate === todayKey;
          if (isDueNow(entry, now) && !alreadySentToday) {
            const msg = MESSAGES[entry.lang] || MESSAGES.fr;
            await admin.messaging().send({
              token,
              notification: { title: msg.title, body: msg.body }
            });
            entry.lastSentDate = todayKey;
            fcmChanged = true;
          }
        } catch (err) {
          const code = err && err.errorInfo && err.errorInfo.code;
          if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
            delete fcmStore[token];
            fcmChanged = true;
          } else {
            console.error('[notifications] Erreur envoi FCM:', err.message);
          }
        }
      }
      if (fcmChanged) saveFcmStore(fcmStore);
    }
  });
}

module.exports = { router, startScheduler };
