const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

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

function makePlan(payload) {
  const context = payload.context || {};
  const profile = context.profile || {};
  const maxReps = Number(profile.maxReps) || 10;
  const days = Array.isArray(profile.days) && profile.days.length ? profile.days : [1,3,5];
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
  return { version: 1, generatedAt: new Date().toISOString(), days: rows };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'pushup-plan-api' });
});

app.post('/api/plan/generate', async (req, res) => {
  try {
    const body = req.body || {};
    const freeModel = process.env.FREE_MODEL_NAME || 'Qwen2.5-3B-Instruct';
    const plan = makePlan({ ...body, model: freeModel });
    res.json(plan);
  } catch (e) {
    res.status(500).json({ error: 'plan_generation_failed' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on ${port}`));
