// notifications-server-addon.js
// ---------------------------------------------------------------------------
// À AJOUTER À TON SERVEUR EXISTANT (pushup-plan-api sur Render), à côté de la
// route /api/plan/generate. Ne remplace rien : ce fichier exporte un routeur
// Express + une fonction pour démarrer la tâche planifiée.
//
// Installation (dans le dossier de ton serveur) :
//   npm install web-push node-cron
//
// Génération des clés VAPID (une seule fois) :
//   npx web-push generate-vapid-keys
// -> copie la clé PUBLIQUE dans PUSH_VAPID_PUBLIC_KEY côté front (le .html)
// -> mets la clé PRIVÉE + PUBLIQUE dans les variables d'environnement Render :
//      VAPID_PUBLIC_KEY=...
//      VAPID_PRIVATE_KEY=...
//      VAPID_SUBJECT=mailto:ton-email@exemple.com
//
// Dans ton fichier serveur principal (ex: server.js / index.js) :
//
//   const express = require('express');
//   const app = express();
//   app.use(express.json());
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

const router = express.Router();

// --- Configuration VAPID ---------------------------------------------------
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contact@example.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('[notifications] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY manquantes : les notifications ne pourront pas être envoyées.');
}

// --- Stockage -----------------------------------------------------------
// Stockage fichier JSON simple, suffisant pour démarrer. ATTENTION : sur
// Render, le disque n'est pas garanti persistant entre les déploiements
// (plan gratuit). Pour un usage en production avec plusieurs utilisateurs,
// remplace loadStore()/saveStore() par une vraie base de données (ex:
// Postgres, Redis, ou un fichier sur un disque persistant Render).
const STORE_PATH = path.join(__dirname, 'push-subscriptions.json');

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

// --- Endpoints --------------------------------------------------------------
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

// Supprime un abonnement
router.post('/api/notifications/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint manquant' });
  const store = loadStore();
  delete store[endpoint];
  saveStore(store);
  res.json({ ok: true });
});

// --- Contenu de la notification (par langue) --------------------------------
const MESSAGES = {
  fr: { title: 'Push-Up', body: "C'est ton jour d'entraînement ! Prêt pour ta séance ?" },
  en: { title: 'Push-Up', body: "It's your workout day! Ready for your session?" },
  es: { title: 'Push-Up', body: '¡Hoy toca entrenar! ¿Listo para tu sesión?' }
};

// --- Tâche planifiée --------------------------------------------------------
// Vérifie chaque minute si un abonné doit recevoir sa notification :
// jour de la semaine (dans son fuseau horaire) présent dans ses jours
// d'entraînement, ET heure locale correspondant à l'heure choisie.
function startScheduler() {
  cron.schedule('* * * * *', async () => {
    const store = loadStore();
    let changed = false;

    for (const [endpoint, entry] of Object.entries(store)) {
      try {
        const now = new Date();

        const localTimeStr = now.toLocaleTimeString('fr-FR', {
          timeZone: entry.timezone || 'UTC',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        });

        const localDateKey = new Intl.DateTimeFormat('en-CA', {
          timeZone: entry.timezone || 'UTC',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        }).format(now);

        const weekdayName = new Intl.DateTimeFormat('en-US', {
          timeZone: entry.timezone || 'UTC',
          weekday: 'short'
        }).format(now);

        const weekdays = {
          Sun: 0,
          Mon: 1,
          Tue: 2,
          Wed: 3,
          Thu: 4,
          Fri: 5,
          Sat: 6
        };

        const localDow = weekdays[weekdayName];

        const isTrainingDay =
          Array.isArray(entry.days) && entry.days.includes(localDow);

        const isTime = localTimeStr === entry.time;
        const alreadySentToday = entry.lastSentDate === localDateKey;

        if (isTrainingDay && isTime && !alreadySentToday) {
          const msg = MESSAGES[entry.lang] || MESSAGES.fr;

          await webpush.sendNotification(
            entry.subscription,
            JSON.stringify({
              ...msg,
              url: 'https://azgaroc.github.io/Push-up/'
            })
          );

          entry.lastSentDate = localDateKey;
          changed = true;

          console.log(
            `[notifications] Push envoyée : ${entry.time} (${entry.timezone})`
          );
        }
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          delete store[endpoint];
          changed = true;
          console.log('[notifications] Abonnement expiré supprimé.');
        } else {
          console.error('[notifications] Erreur envoi push:', err.message);
        }
      }
    }

    if (changed) {
      saveStore(store);
    }
  });

  console.log('[notifications] Planificateur démarré : vérification chaque minute.');
}

module.exports = { router, startScheduler };
