// v50
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const notifications = require('./notifications-server-addon');
app.use(notifications.router);
notifications.startScheduler();

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// ---------- Fallback: deterministic rule-based plan (used if the LLM call fails) ----------

function generateDailyTarget(maxReps, intensity, ratio) {
  const rawBase = Math.max(3, Math.round(maxReps * (0.56 + intensity * 0.06) * ratio));
  const setCount = ratio < 0.82 ? 4 : ratio < 1.02 ? 5 : 6;
  const multipliers = setCount === 4 ? [0.95, 1.0, 0.95, 0.85] : setCount === 5 ? [0.9, 1.0, 0.95, 0.9, 0.8] : [0.85, 0.95, 1.0, 0.95, 0.9, 0.8];
  return multipliers.map(m => clamp(Math.round(rawBase * m), 2, 200));
}

function computeRatio(context, reason) {
  if (reason === 'was_hard') return 0.85;
  if (reason === 'skipped_day') return 0.95;

  const recent = Array.isArray(context.recent) ? context.recent.filter(w => w && w.difficulty !== 'hard') : [];
  const recentHardCount = Array.isArray(context.recentHard) ? context.recentHard.length : 0;

  // Pas d'historique exploitable : base neutre, ni pénalité ni bonus.
  if (!recent.length) return 1;

  // Progression douce et régulière tant qu'aucune séance récente n'a été
  // signalée difficile : chaque séance complétée sans incident pousse
  // légèrement le volume vers le haut, au lieu d'être comparée à une
  // estimation arbitraire du volume "attendu" qui n'a souvent aucun rapport
  // avec ce qu'un utilisateur fait réellement.
  const growth = recentHardCount > 0 ? 0 : Math.min(0.20, recent.length * 0.015);
  return clamp(1 + growth, 0.85, 1.20);
}

// Utilise la date locale envoyée par le client si disponible et valide,
// pour éviter un décalage d'un jour entre le fuseau du serveur et celui de l'utilisateur.
function parseAnchorDate(context) {
  const clientToday = context && context.today;
  if (typeof clientToday === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(clientToday)) {
    const d = new Date(clientToday + 'T00:00:00Z');
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

function makeRuleBasedPlan(payload) {
  const context = payload.context || {};
  const profile = context.profile || {};
  const maxReps = Number(profile.maxReps) || 10;
  const days = Array.isArray(profile.days) && profile.days.length ? profile.days : [1, 3, 5];
  const reason = payload.reason || 'regular';
  const ratio = computeRatio(context, reason);
  const today = parseAnchorDate(context);
  const perSetCap = Math.max(2, Math.round(maxReps * 0.7));
  const dailyTotalCap = (reason === 'initial' || reason === 'was_hard') ? Math.round(maxReps * 2.0) : Math.round(maxReps * 3.6);
  const rows = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const intensity = (days.indexOf(d.getDay()) + 1) || 2;
    let sets = generateDailyTarget(maxReps, intensity, ratio).map(v => clamp(v, 2, perSetCap));
    let total = sets.reduce((a, b) => a + b, 0);
    if (total > dailyTotalCap && total > 0) {
      const factor = dailyTotalCap / total;
      sets = sets.map(v => clamp(Math.round(v * factor), 2, perSetCap));
    }
    if (reason === 'skipped_day' && i === 0) sets = sets.map(v => clamp(Math.round(v * 0.92), 2, perSetCap));
    if (reason === 'was_hard') sets = sets.map(v => clamp(Math.round(v * 0.85), 2, perSetCap));
    rows.push({
      date: d.toISOString().slice(0, 10),
      sets,
      restSeconds: sets.length >= 6 ? 75 : sets.length >= 5 ? 60 : 90,
      note: reason === 'skipped_day' && i === 0 ? 'Volume réduit après jour sauté'
        : reason === 'was_hard' ? 'Volume réduit après une séance difficile'
        : 'Adaptation progressive'
    });
  }
  return { version: 1, generatedAt: new Date().toISOString(), days: rows, source: 'rule-based' };
}

// ---------- Validate / normalize whatever the LLM returns ----------

function normalizeAndValidatePlan(raw, maxReps) {
  if (!raw || !Array.isArray(raw.days) || !raw.days.length) return null;
  const perSetCap = Math.max(2, Math.round((Number(maxReps) || 10) * 0.7));
  const dailyTotalCap = Math.round((Number(maxReps) || 10) * 3.6);
  const days = raw.days
    .map(d => {
      const date = String(d && d.date || '').slice(0, 10);
      let sets = Array.isArray(d && d.sets)
        ? d.sets.map(n => clamp(Math.round(Number(n) || 0), 2, perSetCap)).filter(Boolean)
        : [];
      // Si le total dépasse le plafond journalier malgré le plafond par série,
      // on réduit chaque série au prorata pour rester sous la limite absolue.
      let total = sets.reduce((a, b) => a + b, 0);
      if (total > dailyTotalCap && total > 0) {
        const factor = dailyTotalCap / total;
        sets = sets.map(v => clamp(Math.round(v * factor), 2, perSetCap));
      }
      const restSeconds = clamp(Math.round(Number(d && d.restSeconds) || 60), 30, 300);
      const note = String((d && d.note) || '').slice(0, 200);
      return { date, sets, restSeconds, note };
    })
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.sets.length >= 2 && d.sets.length <= 8);
  if (!days.length) return null;
  return { version: 1, generatedAt: new Date().toISOString(), days, source: 'groq' };
}

// ---------- Real LLM call (Groq, OpenAI-compatible) ----------

function buildPrompt(payload) {
  const context = payload.context || {};
  const profile = context.profile || {};
  const maxReps = Number(profile.maxReps) || 10;
  const dayNames = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  const trainingDays = Array.isArray(profile.days) && profile.days.length
    ? profile.days.map(n => dayNames[n] || n).join(', ')
    : 'non précisé';
  const recent = Array.isArray(context.recent) ? context.recent.slice(0, 14) : [];
  const recentSummary = recent.length
    ? recent.map(w => `${w.isoDate || w.date || '?'}: ${w.total || 0} pompes${w.difficulty === 'hard' ? ' (signalée difficile, ne pas compter comme preuve de capacité accrue)' : ''}`).join(' | ')
    : 'aucune séance récente enregistrée';
  const skippedCount = Array.isArray(context.skipped) ? context.skipped.length : 0;
  const recentHardCount = Array.isArray(context.recentHard) ? context.recentHard.length : 0;
  const today = context.today || new Date().toISOString().slice(0, 10);
  const reason = payload.reason || 'regular';

  // Bornes numériques explicites dérivées du max de l'utilisateur : on ne laisse
  // pas le modèle "interpréter" ce qui est réaliste, on le lui donne en chiffres.
  const perSetCap = Math.max(2, Math.round(maxReps * 0.7));
  const dailyTotalCap = (reason === 'initial' || reason === 'was_hard')
    ? Math.round(maxReps * 2.0)
    : Math.round(maxReps * 3.6);

  const system = `Tu es un coach de musculation spécialisé dans les pompes. Tu génères des plans d'entraînement progressifs, sûrs et réalistes, adaptés aux performances réelles de l'utilisateur. Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte avant ou après, respectant exactement ce schéma :
{"days":[{"date":"YYYY-MM-DD","sets":[nombre,nombre,...],"restSeconds":nombre,"note":"courte phrase d'encouragement ou conseil en français"}]}
Règles STRICTES à respecter, non négociables :
- Génère exactement 5 jours consécutifs à partir d'aujourd'hui (inclus).
- Chaque jour a entre 3 et 6 séries.
- Aucune série ne doit dépasser ${perSetCap} répétitions (soit 70% du maximum de l'utilisateur). Une série proche du maximum absolu est dangereuse et interdite.
- Le total de répétitions sur une journée ne doit JAMAIS dépasser ${dailyTotalCap} répétitions.
- Si les séances récentes (14 derniers jours) ne montrent AUCUNE séance difficile et un bon taux de complétion (peu ou pas de jours sautés), AUGMENTE le volume total de façon régulière d'un plan à l'autre, en te rapprochant progressivement de ${dailyTotalCap} répétitions par jour : un plan qui reste identique ou presque d'une semaine à l'autre alors que tout se passe bien est un échec de progression, pas de la prudence.
- Si l'utilisateur a sauté un entraînement récemment, réduis légèrement le volume du premier jour puis reprends une progression douce.
- Si l'utilisateur a signalé qu'une séance récente était difficile (pauses supplémentaires nécessaires), réduis le volume de TOUS les jours de ce plan d'environ 15%, pas seulement le premier jour : c'est un signal que le calibrage actuel est trop dur, pas un incident isolé.
- N'augmente jamais le volume total de plus de 10% d'un jour à l'autre.
- La prudence s'applique uniquement quand un signal réel de difficulté existe (séance difficile, jours sautés) : en l'absence d'un tel signal, ne stagne pas par précaution, progresse.`;

  const user = `Profil de l'utilisateur :
- Maximum de pompes en une série : ${maxReps}
- Jours d'entraînement habituels : ${trainingDays}
- Date du jour : ${today}
- Raison de la génération : ${reason}
- Séances des 14 derniers jours : ${recentSummary}
- Nombre de jours sautés récemment (7 derniers jours) : ${skippedCount}
- Nombre de séances récentes signalées comme difficiles (7 derniers jours) : ${recentHardCount}

Génère le plan des 5 prochains jours en JSON uniquement, selon le schéma donné.`;

  return { system, user };
}

async function generatePlanWithGroq(payload) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not configured');
  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const { system, user } = buildPrompt(payload);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature: 0.4,
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Groq API ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('Groq API returned no content');
    const parsed = JSON.parse(content);
    const maxReps = Number(payload && payload.context && payload.context.profile && payload.context.profile.maxReps) || 10;
    const plan = normalizeAndValidatePlan(parsed, maxReps);
    if (!plan) throw new Error('Groq API returned an invalid plan shape');
    return plan;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------- Routes ----------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'pushup-plan-api', llm: !!process.env.GROQ_API_KEY });
});

app.post('/api/plan/generate', async (req, res) => {
  const body = req.body || {};
  try {
    const plan = await generatePlanWithGroq(body);
    res.json(plan);
  } catch (e) {
    console.error('Groq generation failed, falling back to rule-based plan:', e.message);
    try {
      const plan = makeRuleBasedPlan(body);
      res.json(plan);
    } catch (e2) {
      res.status(500).json({ error: 'plan_generation_failed' });
    }
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on ${port}`));
