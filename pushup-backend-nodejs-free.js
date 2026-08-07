// v53
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

function generateDailyTarget(maxReps, dayIndexInPlan, ratio) {
  // Légère rampe à l'intérieur des 5 jours du plan (0 à 4), au lieu de dépendre
  // de la position du jour dans la semaine — ça évite les dents de scie qui
  // remontent puis retombent brutalement d'une semaine à l'autre.
  const rampFactor = 0.68 + clamp(dayIndexInPlan, 0, 4) * 0.015;
  const rawBase = Math.max(3, Math.round(maxReps * rampFactor * ratio));
  const setCount = ratio < 0.82 ? 4 : ratio < 1.02 ? 5 : 6;
  const multipliers = setCount === 4 ? [0.95, 1.0, 0.95, 0.85] : setCount === 5 ? [0.9, 1.0, 0.95, 0.9, 0.8] : [0.85, 0.95, 1.0, 0.95, 0.9, 0.8];
  return multipliers.map(m => clamp(Math.round(rawBase * m), 2, 200));
}

// Compte le nombre de jours consécutifs (calendaires) sur lesquels l'utilisateur
// vient de s'entraîner, en repartant de la séance la plus récente. Reflète le
// rythme RÉEL (ce qu'il fait), pas seulement les jours qu'il a cochés dans son
// profil (ce qu'il a prévu de faire) — un signal bien plus fiable pour détecter
// un vrai risque de surentraînement.
function computeConsecutiveTrainingStreak(context) {
  const recent = Array.isArray(context.recent) ? context.recent : [];
  const dates = [...new Set(recent.map(w => w && w.isoDate).filter(Boolean))].sort();
  if (!dates.length) return 0;
  let streak = 1;
  for (let i = dates.length - 1; i > 0; i--) {
    const prev = new Date(dates[i - 1] + 'T00:00:00Z');
    const cur = new Date(dates[i] + 'T00:00:00Z');
    const diff = Math.round((cur - prev) / 86400000);
    if (diff <= 1) streak++; else break;
  }
  return streak;
}

function computeRatio(context, reason) {
  if (reason === 'was_hard') return 0.85;
  if (reason === 'skipped_day') return 0.95;
  if (reason === 'was_easy') return 1.15; // signal explicite : augmentation nette, pas juste la progression douce habituelle

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
  const reason = payload.reason || 'regular';
  const ratio = computeRatio(context, reason);
  const today = parseAnchorDate(context);
  const perSetCap = Math.max(2, Math.round(maxReps * 0.7));
  const dailyTotalCap = (reason === 'initial' || reason === 'was_hard') ? Math.round(maxReps * 2.0) : Math.round(maxReps * 3.6);
  const recentHardCount = Array.isArray(context.recentHard) ? context.recentHard.length : 0;
  const trainingDaysPerWeek = Array.isArray(profile.days) ? profile.days.length : 0;
  const consecutiveStreak = computeConsecutiveTrainingStreak(context);
  // BUGFIX : l'ancienne condition exigeait À LA FOIS >=6 jours/semaine ET une
  // séance signalée "difficile" récemment. Si l'utilisateur ne signale jamais
  // "Difficile" (fréquent : beaucoup ne cliquent que "Bien passée"), aucun repos
  // n'était JAMAIS imposé, même en s'entraînant tous les jours sans interruption.
  // Le repos peut maintenant être déclenché par 3 signaux indépendants, du plus
  // fort au plus doux — et ne dépend plus uniquement du feedback explicite :
  const forcedRestDayIndex = (reason === 'initial') ? -1
    : (recentHardCount >= 2) ? 1                                    // fatigue confirmée sur plusieurs séances : repos rapproché
    : (recentHardCount >= 1 && trainingDaysPerWeek >= 5) ? 2         // un signal de fatigue + rythme déjà soutenu
    : (consecutiveStreak >= 6) ? 2                                   // 6 jours d'affilée sans la moindre coupure, même sans plainte explicite
    : -1;
  const rows = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    if (i === forcedRestDayIndex) {
      rows.push({
        date: d.toISOString().slice(0, 10),
        sets: [],
        restSeconds: 0,
        note: 'Jour de repos imposé par ton coach : rythme soutenu et signes de fatigue récents.'
      });
      continue;
    }
    let sets = generateDailyTarget(maxReps, i, ratio).map(v => clamp(v, 2, perSetCap));
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

// Reconstruit une répartition cohérente (courbe progressive) à partir d'un total
// donné, au lieu d'une chute brutale sur la dernière série. Utilise les mêmes
// courbes que le générateur de secours (rule-based), pour un résultat cohérent
// quelle que soit l'origine du plan (IA ou secours).
const SET_DISTRIBUTION_CURVES = {
  2: [1.0, 0.9],
  3: [1.0, 0.95, 0.85],
  4: [0.95, 1.0, 0.95, 0.85],
  5: [0.9, 1.0, 0.95, 0.9, 0.8],
  6: [0.85, 0.95, 1.0, 0.95, 0.9, 0.8],
  7: [0.8, 0.9, 0.95, 1.0, 0.95, 0.9, 0.8],
  8: [0.75, 0.85, 0.95, 1.0, 1.0, 0.95, 0.9, 0.8]
};
function redistributeEvenly(sets, perSetCap) {
  const n = sets.length;
  const total = sets.reduce((a, b) => a + b, 0);
  if (n < 2 || total <= 0) return sets;
  const curve = SET_DISTRIBUTION_CURVES[n] || Array(n).fill(1);
  const curveSum = curve.reduce((a, b) => a + b, 0);
  const base = total / curveSum;
  return curve.map(m => clamp(Math.round(base * m), 2, perSetCap));
}
// BUGFIX : rien ne vérifiait auparavant la FORME de la répartition entre séries
// d'une même journée — seuls le plafond par série et le total journalier étaient
// contrôlés. Un modèle pouvait donc renvoyer 10+10+10+2 (les 3 premières séries
// au plafond max, puis un reliquat minuscule pour boucler le total) sans jamais
// être corrigé : chaque valeur individuelle respectait bien les plafonds, mais la
// répartition n'avait aucun sens à l'entraînement. On détecte maintenant ce cas
// (plus petite série < 55% de la plus grande, sur 3 séries ou plus) et on
// recalcule une vraie courbe progressive à partir du même total.
function fixUnevenDistribution(sets, perSetCap) {
  if (!Array.isArray(sets) || sets.length < 3) return sets;
  const max = Math.max(...sets);
  const min = Math.min(...sets);
  if (max <= 0 || min >= max * 0.55) return sets;
  return redistributeEvenly(sets, perSetCap);
}

function normalizeAndValidatePlan(raw, maxReps, reason) {
  if (!raw || !Array.isArray(raw.days) || !raw.days.length) return null;
  const perSetCap = Math.max(2, Math.round((Number(maxReps) || 10) * 0.7));
  // BUGFIX : ce filet de sécurité utilisait toujours le plafond large (3.6x),
  // même pour les raisons "initial"/"was_hard" où le prompt demande au modèle
  // de respecter un plafond réduit (2.0x). Si jamais le modèle ne respectait pas
  // parfaitement cette consigne réduite, rien ici ne la faisait appliquer : la
  // validation laissait passer un volume bien plus élevé que ce que la
  // situation justifiait. Le plafond de secours doit toujours être IDENTIQUE à
  // celui donné au modèle dans buildPrompt(), sinon il ne protège pas grand-chose.
  const dailyTotalCap = (reason === 'initial' || reason === 'was_hard')
    ? Math.round((Number(maxReps) || 10) * 2.0)
    : Math.round((Number(maxReps) || 10) * 3.6);
  const days = raw.days
    .map(d => {
      const date = String(d && d.date || '').slice(0, 10);
      let sets = Array.isArray(d && d.sets)
        ? d.sets.map(n => clamp(Math.round(Number(n) || 0), 2, perSetCap)).filter(Boolean)
        : [];
      sets = fixUnevenDistribution(sets, perSetCap);
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
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date) && (d.sets.length === 0 || (d.sets.length >= 2 && d.sets.length <= 8)));
  if (!days.length) return null;

  // Filet de sécurité : même si l'IA ne respecte pas parfaitement la consigne,
  // on lisse ici toute variation de plus de 10% (hausse ou baisse) d'un jour
  // au suivant, pour garantir une progression cohérente sur les 5 jours.
  for (let i = 1; i < days.length; i++) {
    const prevTotal = days[i - 1].sets.reduce((a, b) => a + b, 0);
    const total = days[i].sets.reduce((a, b) => a + b, 0);
    if (prevTotal <= 0 || total <= 0) continue;
    const minAllowed = prevTotal * 0.9;
    const maxAllowed = prevTotal * 1.1;
    if (total < minAllowed || total > maxAllowed) {
      const target = clamp(total, minAllowed, maxAllowed);
      const factor = target / total;
      days[i].sets = days[i].sets.map(v => clamp(Math.round(v * factor), 2, perSetCap));
    }
  }

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
  // BUGFIX : le prompt ne donnait auparavant qu'un PLAFOND (dailyTotalCap), jamais
  // de plancher de référence. Résultat : un total journalier très timide (ex: 3
  // séries pour à peine 22 répétitions avec un maximum déclaré de 40) respectait
  // à la lettre toutes les règles ("entre 3 et 6 séries", "sous le plafond") sans
  // jamais être signalé comme insuffisant — le modèle pouvait donc être
  // arbitrairement prudent sans jamais violer une consigne explicite. On lui donne
  // maintenant une fourchette de référence concrète pour un jour d'entraînement
  // normal, dérivée de la même logique que l'algorithme de secours déterministe.
  const baselineLow = (reason === 'initial') ? Math.round(maxReps * 1.3)
    : (reason === 'was_hard') ? Math.round(maxReps * 1.1)
    : Math.round(maxReps * 2.0);
  const baselineHigh = (reason === 'initial') ? Math.round(maxReps * 1.7)
    : (reason === 'was_hard') ? Math.round(maxReps * 1.5)
    : Math.round(maxReps * 3.0);

  const system = `Tu es un coach sportif spécialisé dans les pompes. Tu génères des plans d'entraînement progressifs, sûrs et réalistes, adaptés aux performances réelles de l'utilisateur. Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte avant ou après, respectant exactement ce schéma :
{"days":[{"date":"YYYY-MM-DD","sets":[nombre,nombre,...],"restSeconds":nombre,"note":"courte phrase d'encouragement ou conseil en français"}]}
Un jour peut être un jour de repos IMPOSÉ par toi : dans ce cas, mets "sets":[] (tableau vide) et explique brièvement pourquoi dans "note". C'est la seule façon de marquer un repos obligatoire.
Règles STRICTES à respecter, non négociables :
- Génère exactement 5 jours consécutifs à partir d'aujourd'hui (inclus).
- Pour un jour d'entraînement (pas un repos imposé), chaque jour a entre 3 et 6 séries.
- Aucune série ne doit dépasser ${perSetCap} répétitions (soit 70% du maximum de l'utilisateur). Une série proche du maximum absolu est dangereuse et interdite.
- RÉPARTITION entre les séries d'une même journée : ne te contente jamais de maximiser les premières séries puis de "compléter" la dernière avec un petit reliquat pour atteindre le total (par exemple 10+10+10+2 est INTERDIT). La répartition doit suivre une courbe cohérente et progressive (par exemple une légère montée en charge puis une fin un peu plus légère, du type 8+9+8+7), où aucune série n'est inférieure à 60% de la plus grande série de la même journée.
- Le total de répétitions sur une journée ne doit JAMAIS dépasser ${dailyTotalCap} répétitions.
- VOLUME DE RÉFÉRENCE pour un jour d'entraînement normal (hors repos), compte tenu de la raison "${reason}" et du maximum de ${maxReps} de l'utilisateur : vise un total journalier entre environ ${baselineLow} et ${baselineHigh} répétitions, sauf signal contraire déjà couvert par les règles ci-dessous (séance difficile, jour sauté...). Un total nettement inférieur à cette fourchette (par exemple 3 séries totalisant à peine la moitié de ${baselineLow}) est trop timide et n'est pas un choix "prudent" acceptable en l'absence d'une raison spécifique de le justifier.
- Si les séances récentes (14 derniers jours) ne montrent AUCUNE séance difficile et un bon taux de complétion (peu ou pas de jours sautés), AUGMENTE le volume total de façon régulière d'un plan à l'autre, en te rapprochant progressivement de ${dailyTotalCap} répétitions par jour : un plan qui reste identique ou presque d'une semaine à l'autre alors que tout se passe bien est un échec de progression, pas de la prudence.
- Si l'utilisateur a sauté un entraînement récemment, réduis légèrement le volume du premier jour puis reprends une progression douce.
- Si l'utilisateur a signalé qu'une séance récente était difficile (pauses supplémentaires nécessaires), réduis le volume de TOUS les jours de ce plan d'environ 15%, pas seulement le premier jour : c'est un signal que le calibrage actuel est trop dur, pas un incident isolé.
- Si la raison de génération est "was_easy" (l'utilisateur a explicitement signalé que la dernière séance était trop facile), augmente le volume total de façon nette (environ +15% par rapport au dernier plan), dans la limite des plafonds de sécurité ci-dessus : c'est un signal explicite qu'il faut plus de challenge, à traiter différemment d'une progression douce habituelle.
- Si la raison de génération est "extra_reps" : l'utilisateur a fait une séance libre supplémentaire, EN PLUS de son plan normal, le même jour. C'est un signe de motivation, pas un signal de fatigue ni une raison de réduire le volume prévu — poursuis la progression normale décrite ci-dessus, ne stagne pas et ne compense pas à la baisse à cause de ça.
- Si la raison de génération est "ahead_session" : l'utilisateur a déjà réalisé, en avance, la séance qui était prévue pour demain (en plus de celle d'aujourd'hui). Adapte uniquement le volume de demain (déjà fait) à la baisse ou en repos léger pour éviter un cumul excessif sur deux jours, puis reprends une progression normale pour la suite du plan — ne fais pas stagner l'ensemble des 5 jours pour autant.
- Si la raison de génération est "recalibration" : l'utilisateur vient de mesurer un nouveau maximum de répétitions (le "Maximum de pompes en une série" ci-dessous reflète déjà cette nouvelle valeur). Repars sur une base neutre et prudente alignée sur ce nouveau maximum, sans viser d'emblée les plafonds de sécurité.
- Si la raison de génération est "regular" (cas par défaut, aucun signal particulier) : applique uniquement la logique de progression standard décrite plus haut, comme s'il n'y avait aucune raison spéciale.
- N'augmente jamais le volume total de plus de 10% d'un jour à l'autre, ET ne le réduis jamais de plus de 10% d'un jour à l'autre (sauf jour sauté, séance difficile signalée, ou jour de repos imposé) : les 5 jours du plan doivent former une progression lisse et cohérente, jamais une suite qui monte puis retombe brutalement.
- La prudence s'applique uniquement quand un signal réel de difficulté existe (séance difficile, jours sautés) : en l'absence d'un tel signal, ne stagne pas par précaution, progresse.
- Jours de repos imposés (indépendamment des jours d'entraînement choisis par l'utilisateur) : c'est TOI qui décides, en te basant sur l'historique RÉEL des séances (les dates ci-dessous), pas sur les jours que l'utilisateur a cochés dans son profil — ces jours-là ne sont qu'un souhait de calendrier, pas une obligation médicale. Impose un jour de repos dans les 5 jours du plan si l'UN de ces signaux est présent : (a) au moins une séance récente signalée difficile ET un rythme d'au moins 5 jours/semaine, (b) plusieurs séances récentes signalées difficiles, ou (c) l'utilisateur s'entraîne actuellement plusieurs jours consécutifs sans la moindre coupure (regarde les dates des séances récentes ci-dessous : des dates qui se suivent sans interruption sur 6 jours ou plus est en soi un signal de fatigue à traiter, même si l'utilisateur n'a jamais signalé de séance difficile). Dans ce dernier cas (c), agis même si l'utilisateur a explicitement choisi de s'entraîner tous les jours de la semaine dans son profil : ton rôle est de protéger sa récupération, pas de suivre aveuglément son calendrier préféré. Si au contraire aucun de ces signaux n'est présent, n'impose AUCUN repos superflu. Ne mets jamais deux jours de repos imposés consécutifs.`;

  const user = `Profil de l'utilisateur :
- Maximum de pompes en une série : ${maxReps}
- Jours d'entraînement habituels : ${trainingDays}
- Date du jour : ${today}
- Raison de la génération : ${reason}
- Nombre de jours d'entraînement choisis par semaine : ${Array.isArray(profile.days) ? profile.days.length : 'non précisé'}
- Séances des 14 derniers jours : ${recentSummary}
- Jours consécutifs sans coupure jusqu'à aujourd'hui (calculé pour toi) : ${computeConsecutiveTrainingStreak(context)}
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
    const plan = normalizeAndValidatePlan(parsed, maxReps, payload && payload.reason);
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
