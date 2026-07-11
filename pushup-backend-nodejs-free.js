const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

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

function computeRatio(context) {
  const profile = context.profile || {};
  const maxReps = Number(profile.maxReps) || 10;
  const recent = Array.isArray(context.recent) ? context.recent : [];
  if (!recent.length) return 1;
  const avg = recent.reduce((s, w) => s + (Number(w.total) || 0), 0) / recent.length;
  return clamp(avg / Math.max(1, maxReps * 4), 0.75, 1.15);
}

function makeRuleBasedPlan(payload) {
  const context = payload.context || {};
  const profile = context.profile || {};
  const maxReps = Number(profile.maxReps) || 10;
  const days = Array.isArray(profile.days) && profile.days.length ? profile.days : [1, 3, 5];
  const ratio = computeRatio(context);
  const reason = payload.reason || 'regular';
  const today = new Date();
  const rows = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const intensity = (days.indexOf(d.getDay()) + 1) || 2;
    let sets = generateDailyTarget(maxReps, intensity, ratio);
    if (reason === 'skipped_day' && i === 0) sets = sets.map(v => clamp(Math.round(v * 0.92), 2, 200));
    rows.push({
      date: d.toISOString().slice(0, 10),
      sets,
      restSeconds: sets.length >= 6 ? 75 : sets.length >= 5 ? 60 : 90,
      note: reason === 'skipped_day' && i === 0 ? 'Volume réduit après jour sauté' : 'Adaptation progressive'
    });
  }
  return { version: 1, generatedAt: new Date().toISOString(), days: rows, source: 'rule-based' };
}

// ---------- Validate / normalize whatever the LLM returns ----------

function normalizeAndValidatePlan(raw) {
  if (!raw || !Array.isArray(raw.days) || !raw.days.length) return null;
  const days = raw.days
    .map(d => {
      const date = String(d && d.date || '').slice(0, 10);
      const sets = Array.isArray(d && d.sets)
        ? d.sets.map(n => clamp(Math.round(Number(n) || 0), 2, 200)).filter(Boolean)
        : [];
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
    ? recent.map(w => `${w.isoDate || w.date || '?'}: ${w.total || 0} pompes`).join(' | ')
    : 'aucune séance récente enregistrée';
  const skippedCount = Array.isArray(context.skipped) ? context.skipped.length : 0;
  const today = context.today || new Date().toISOString().slice(0, 10);
  const reason = payload.reason || 'regular';

  const system = `Tu es un coach de musculation spécialisé dans les pompes. Tu génères des plans d'entraînement progressifs, sûrs et réalistes, adaptés aux performances réelles de l'utilisateur. Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte avant ou après, respectant exactement ce schéma :
{"days":[{"date":"YYYY-MM-DD","sets":[nombre,nombre,...],"restSeconds":nombre,"note":"courte phrase d'encouragement ou conseil en français"}]}
Règles : génère exactement 5 jours consécutifs à partir d'aujourd'hui (inclus). Chaque jour a entre 3 et 6 séries. Le nombre de répétitions par série doit rester réaliste par rapport au maximum de l'utilisateur, jamais brutal. Si l'utilisateur a sauté un entraînement récemment, réduis légèrement le volume du premier jour puis reprends une progression douce. Ne dépasse jamais une augmentation de plus de 10% de volume total d'un jour à l'autre.`;

  const user = `Profil de l'utilisateur :
- Maximum de pompes en une série : ${maxReps}
- Jours d'entraînement habituels : ${trainingDays}
- Date du jour : ${today}
- Raison de la génération : ${reason}
- Séances des 14 derniers jours : ${recentSummary}
- Nombre de jours sautés récemment (7 derniers jours) : ${skippedCount}

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
    const plan = normalizeAndValidatePlan(parsed);
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
