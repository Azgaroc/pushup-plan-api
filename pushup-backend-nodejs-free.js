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

// ---------- Ratio piloté par classifyCoachState() (fallback déterministe uniquement) ----------
// Remplace, pour makeRuleBasedPlan() uniquement, la branche "aucune raison
// explicite" de computeRatio() (conservée ci-dessus, non supprimée, mais plus
// appelée) par une décision basée sur buildPerformanceSnapshot()/
// classifyCoachState(). Les 3 raisons immédiates (was_hard/skipped_day/was_easy)
// gardent exactement le même comportement : ce sont des signaux directs liés à
// l'action qui vient de déclencher cet appel, pas des tendances historiques.
//
// Magnitudes validées comme paramètres EXPÉRIMENTAUX pour cette première
// intégration (à ajuster avec des données réelles, notamment NEEDS_RECOVERY à
// 0.85 = plancher technique actuel, pas une valeur physiologique définitive).
const RATIO_DELTA_BY_PROGRESSION_EFFECT = {
  increase: 0.12,          // PROGRESSING
  push: 0.06,               // STAGNATION
  cautious_increase: 0.03,  // FATIGUE_RISK/watch
  neutral: 0.00,            // STABLE
  freeze_or_cut: -0.05,     // REGRESSION
  reduce: -0.12,            // FATIGUE_RISK/confirmed
  reduce_sharply: -0.25     // NEEDS_RECOVERY (ramené au plancher 0.85 par le clamp ci-dessous)
};

function computeRatioFromCoachState(context, reason, referenceDateIso) {
  if (reason === 'was_hard') return { ratio: 0.85, classification: null, lastPlanWorkout: null, daysSinceLastPlanWorkout: null };
  if (reason === 'skipped_day') return { ratio: 0.95, classification: null, lastPlanWorkout: null, daysSinceLastPlanWorkout: null };
  if (reason === 'was_easy') return { ratio: 1.15, classification: null, lastPlanWorkout: null, daysSinceLastPlanWorkout: null };

  const history = Array.isArray(context.history) ? context.history : [];
  const profile = context.profile || {};
  const snapshot = buildPerformanceSnapshot(history, profile, referenceDateIso);
  const classification = classifyCoachState(snapshot);
  const delta = RATIO_DELTA_BY_PROGRESSION_EFFECT[classification.progressionEffect] || 0;

  // Mêmes bornes absolues que l'ancien computeRatio() : [0.85, 1.20].
  return {
    ratio: clamp(1 + delta, 0.85, 1.20),
    classification,
    lastPlanWorkout: snapshot.lastPlanWorkout,
    daysSinceLastPlanWorkout: snapshot.daysSinceLastPlanWorkout
  };
}

// ---------- Garde de continuité inter-plan (jour 0 uniquement) ----------
const CONTINUITY_MAX_INCREASE_PCT = 0.20;
const CONTINUITY_MAX_DECREASE_PCT = 0.30;
const CONTINUITY_MAX_DECREASE_PCT_NEEDS_RECOVERY = 0.50;
const CONTINUITY_STALE_AFTER_DAYS = 21;

// sets : séries déjà passées par TOUS les traitements existants (dailyTotalCap,
// skipped_day, was_hard) — cette garde intervient en tout dernier, sur le total
// FINAL, jamais avant. Redistribue proportionnellement comme le fait déjà
// dailyTotalCap, PUIS corrige les écarts d'arrondi/clamp par petits pas entiers
// pour garantir que le total réel après redistribution respecte bien la borne
// (et pas seulement le facteur de mise à l'échelle avant arrondi).
function applyContinuityGuard(sets, lastPlanWorkout, daysSinceLastPlanWorkout, classificationState, perSetCap) {
  if (!lastPlanWorkout) {
    console.log('[coach-v2] continuité inter-plan : no_last_plan_workout (aucune séance Plan réelle, garde inactive)');
    return sets;
  }
  if (daysSinceLastPlanWorkout === null || daysSinceLastPlanWorkout > CONTINUITY_STALE_AFTER_DAYS) {
    console.log(`[coach-v2] continuité inter-plan : stale_reference (dernier réel il y a ${daysSinceLastPlanWorkout} j > ${CONTINUITY_STALE_AFTER_DAYS} j, garde inactive)`);
    return sets;
  }
  const lastTotal = lastPlanWorkout.total;
  if (!(lastTotal > 0)) return sets;

  const maxDecreasePct = classificationState === 'NEEDS_RECOVERY' ? CONTINUITY_MAX_DECREASE_PCT_NEEDS_RECOVERY : CONTINUITY_MAX_DECREASE_PCT;
  const minAllowed = Math.round(lastTotal * (1 - maxDecreasePct));
  const maxAllowed = Math.round(lastTotal * (1 + CONTINUITY_MAX_INCREASE_PCT));

  const currentTotal = sets.reduce((a, b) => a + b, 0);
  if (currentTotal >= minAllowed && currentTotal <= maxAllowed) {
    console.log(`[coach-v2] continuité inter-plan : within_bounds (total=${currentTotal}, bornes=[${minAllowed}, ${maxAllowed}])`);
    return sets;
  }

  const targetTotal = clamp(currentTotal, minAllowed, maxAllowed);
  const factor = targetTotal / currentTotal;
  let newSets = sets.map(v => clamp(Math.round(v * factor), 2, perSetCap));

  // Correction anti-arrondi : la mise à l'échelle + le clamp par série peuvent
  // laisser le total réel légèrement hors bornes (chaque série arrondit/écrête
  // indépendamment). On ajuste ici série par série, par pas de 1, jusqu'à ce
  // que le total réel respecte strictement [minAllowed, maxAllowed].
  let actualTotal = newSets.reduce((a, b) => a + b, 0);
  let guardIterations = 0;
  while (actualTotal > maxAllowed && guardIterations < 200) {
    const idx = newSets.reduce((best, v, i) => (v > 2 && (best === -1 || v > newSets[best])) ? i : best, -1);
    if (idx === -1) break;
    newSets[idx]--; actualTotal--; guardIterations++;
  }
  while (actualTotal < minAllowed && guardIterations < 200) {
    const idx = newSets.reduce((best, v, i) => (v < perSetCap && (best === -1 || v < newSets[best])) ? i : best, -1);
    if (idx === -1) break;
    newSets[idx]++; actualTotal++; guardIterations++;
  }

  const reasonLabel = currentTotal > maxAllowed ? 'clamped_up' : 'clamped_down';
  console.log(`[coach-v2] continuité inter-plan : ${reasonLabel} (candidat=${currentTotal} -> final=${actualTotal}, bornes=[${minAllowed}, ${maxAllowed}], état=${classificationState})`);
  return newSets;
}

// ---------- Séance de récupération déterministe (NEEDS_RECOVERY, jour 0) ----------
const RECOVERY_SESSION_SET_COUNT = 3;
const RECOVERY_SESSION_VOLUME_RATIO_OF_LAST_TOTAL = 0.6;
const RECOVERY_SESSION_VOLUME_RATIO_OF_NORMAL_PLAN = 0.7;
const RECOVERY_SESSION_FALLBACK_MAXREPS_MULTIPLIER = 1.2; // fallback théoriquement inatteignable : NEEDS_RECOVERY implique toujours lastPlanWorkout non-null (voir classifyCoachState, priorité 0)
const RECOVERY_SESSION_REST_SECONDS = 120;
const RECOVERY_SESSION_NOTE = 'Séance de récupération : volume réduit, repos allongé entre les séries. Ton coach a détecté des signes de fatigue dans tes séances récentes.';

// Reproduit exactement ce que la branche normale calculerait pour le jour 0
// (generateDailyTarget + clamp dailyTotalCap), pour servir de référence de
// comparaison à la séance de récupération — jamais renvoyé tel quel comme plan.
function computeNormalDay0Total(maxReps, ratio, perSetCap, dailyTotalCap) {
  let sets = generateDailyTarget(maxReps, 0, ratio).map(v => clamp(v, 2, perSetCap));
  let total = sets.reduce((a, b) => a + b, 0);
  if (total > dailyTotalCap && total > 0) {
    const factor = dailyTotalCap / total;
    sets = sets.map(v => clamp(Math.round(v * factor), 2, perSetCap));
    total = sets.reduce((a, b) => a + b, 0);
  }
  return total;
}

// recoveryTotal = min(60% du dernier total Plan réel, 70% du volume que le
// moteur normal aurait calculé pour ce jour 0) : empêche une récupération
// d'être paradoxalement plus chargée que ce que le plan normal aurait proposé.
function buildRecoverySessionSets(maxReps, lastPlanWorkout, perSetCap, ratio, dailyTotalCap) {
  const normalDay0Total = computeNormalDay0Total(maxReps, ratio, perSetCap, dailyTotalCap);
  const fromLastReal = (lastPlanWorkout && lastPlanWorkout.total > 0)
    ? Math.round(lastPlanWorkout.total * RECOVERY_SESSION_VOLUME_RATIO_OF_LAST_TOTAL)
    : Math.round(maxReps * RECOVERY_SESSION_FALLBACK_MAXREPS_MULTIPLIER);
  const fromNormalPlan = Math.round(normalDay0Total * RECOVERY_SESSION_VOLUME_RATIO_OF_NORMAL_PLAN);
  const targetTotal = Math.min(fromLastReal, fromNormalPlan);
  const n = RECOVERY_SESSION_SET_COUNT;
  const base = Math.floor(targetTotal / n);
  const remainder = targetTotal - base * n;
  const sets = Array(n).fill(base);
  for (let i = 0; i < remainder; i++) sets[i]++;
  return sets.map(v => clamp(v, 2, perSetCap));
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

// Extraction pure (aucun changement de logique) de la chaîne de décision du
// jour de repos forcé, pour être partagée entre makeRuleBasedPlan() et le
// chemin LLM (normalizeAndValidatePlanV2()) — une seule source de vérité.
function computeForcedRestDayIndex({ reason, recentHardCount, trainingDaysPerWeek, consecutiveStreak, classification }) {
  const coachForcedRest = !!(classification && classification.forcedRest);
  // BUGFIX : l'ancienne condition exigeait À LA FOIS >=6 jours/semaine ET une
  // séance signalée "difficile" récemment. Si l'utilisateur ne signale jamais
  // "Difficile" (fréquent : beaucoup ne cliquent que "Bien passée"), aucun repos
  // n'était JAMAIS imposé, même en s'entraînant tous les jours sans interruption.
  // Le repos peut maintenant être déclenché par 4 signaux indépendants, du plus
  // fort au plus doux — et ne dépend plus uniquement du feedback explicite :
  return (reason === 'initial') ? -1
    : (recentHardCount >= 2) ? 1                                    // fatigue confirmée sur plusieurs séances : repos rapproché
    : (recentHardCount >= 1 && trainingDaysPerWeek >= 5) ? 2         // un signal de fatigue + rythme déjà soutenu
    : (consecutiveStreak >= 6) ? 2                                   // 6 jours d'affilée sans la moindre coupure, même sans plainte explicite
    : coachForcedRest ? 1                                            // NEEDS_RECOVERY détecté par l'analyse historique, sans signal des 3 branches ci-dessus
    : -1;
}

// Extraction pure (aucun changement de logique) de la génération d'un jour
// d'entraînement "normal" — réutilisée par makeRuleBasedPlan() et par le
// chemin LLM pour reboucher tout jour manquant/invalide/repos non autorisé
// avec exactement la même formule déterministe.
function buildNormalTrainingDaySets(maxReps, dayIndex, ratio, perSetCap, dailyTotalCap, reason) {
  let sets = generateDailyTarget(maxReps, dayIndex, ratio).map(v => clamp(v, 2, perSetCap));
  let total = sets.reduce((a, b) => a + b, 0);
  if (total > dailyTotalCap && total > 0) {
    const factor = dailyTotalCap / total;
    sets = sets.map(v => clamp(Math.round(v * factor), 2, perSetCap));
  }
  if (reason === 'skipped_day' && dayIndex === 0) sets = sets.map(v => clamp(Math.round(v * 0.92), 2, perSetCap));
  if (reason === 'was_hard') sets = sets.map(v => clamp(Math.round(v * 0.85), 2, perSetCap));
  return sets;
}

// Point d'entrée UNIQUE pour Coach V2, utilisé par les DEUX chemins (fallback
// rule-based et LLM) : calcule une seule fois tout ce dont les garde-fous ont
// besoin, à partir du même payload. Aucun des deux chemins ne recalcule quoi
// que ce soit indépendamment — même source de vérité partout.
function computeCoachConstraints(payload) {
  const context = payload.context || {};
  const profile = context.profile || {};
  const maxReps = Number(profile.maxReps) || 10;
  const reason = payload.reason || 'regular';
  const today = parseAnchorDate(context);
  const referenceDateIso = today.toISOString().slice(0, 10);
  const { ratio, classification, lastPlanWorkout, daysSinceLastPlanWorkout } = computeRatioFromCoachState(context, reason, referenceDateIso);
  const perSetCap = Math.max(2, Math.round(maxReps * 0.7));
  const dailyTotalCap = (reason === 'initial' || reason === 'was_hard') ? Math.round(maxReps * 2.0) : Math.round(maxReps * 3.6);
  const recentHardCount = Array.isArray(context.recentHard) ? context.recentHard.length : 0;
  const trainingDaysPerWeek = Array.isArray(profile.days) ? profile.days.length : 0;
  const consecutiveStreak = computeConsecutiveTrainingStreak(context);
  const forcedRestDayIndex = computeForcedRestDayIndex({ reason, recentHardCount, trainingDaysPerWeek, consecutiveStreak, classification });
  return { maxReps, reason, today, referenceDateIso, ratio, classification, lastPlanWorkout, daysSinceLastPlanWorkout, perSetCap, dailyTotalCap, forcedRestDayIndex };
}

function makeRuleBasedPlan(payload) {
  const constraints = computeCoachConstraints(payload);
  const { maxReps, reason, today, ratio, classification, lastPlanWorkout, daysSinceLastPlanWorkout, perSetCap, dailyTotalCap, forcedRestDayIndex } = constraints;
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
    // Séance de récupération déterministe : jour 0 UNIQUEMENT, quand la
    // classification est NEEDS_RECOVERY. Remplace intégralement la génération
    // normale pour ce jour (structure à 3 séries + repos allongé, pas juste un
    // ratio réduit sur la courbe habituelle).
    const isRecoveryDay = (i === 0) && classification && classification.state === 'NEEDS_RECOVERY';
    let sets;
    if (isRecoveryDay) {
      sets = buildRecoverySessionSets(maxReps, lastPlanWorkout, perSetCap, ratio, dailyTotalCap);
    } else {
      sets = buildNormalTrainingDaySets(maxReps, i, ratio, perSetCap, dailyTotalCap, reason);
    }
    // Garde de continuité inter-plan : jour 0 UNIQUEMENT, après tous les
    // traitements ci-dessus. Purement additive ; inactive (retourne sets tel
    // quel) si aucune référence exploitable — voir applyContinuityGuard().
    if (i === 0 && i !== forcedRestDayIndex) {
      sets = applyContinuityGuard(sets, lastPlanWorkout, daysSinceLastPlanWorkout, classification ? classification.state : null, perSetCap);
    }
    rows.push({
      date: d.toISOString().slice(0, 10),
      sets,
      restSeconds: isRecoveryDay ? RECOVERY_SESSION_REST_SECONDS : (sets.length >= 6 ? 75 : sets.length >= 5 ? 60 : 90),
      note: isRecoveryDay ? RECOVERY_SESSION_NOTE
        : reason === 'skipped_day' && i === 0 ? 'Volume réduit après jour sauté'
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

const FORCED_REST_NOTE = 'Jour de repos imposé par ton coach : rythme soutenu et signes de fatigue récents.';

// Dernière barrière de sécurité pour le chemin LLM : `constraints` (calculée
// une seule fois par computeCoachConstraints(), même source de vérité que
// makeRuleBasedPlan()) a la priorité absolue sur tout ce que Groq a proposé.
// Groq peut choisir la répartition des séries à l'intérieur des contraintes,
// mais ne décide jamais : l'état Coach, le volume max/min, le repos
// obligatoire, la récupération, la continuité, perSetCap ou dailyTotalCap.
function normalizeAndValidatePlanV2(raw, constraints) {
  const { maxReps, ratio, perSetCap, dailyTotalCap, forcedRestDayIndex, classification, lastPlanWorkout, daysSinceLastPlanWorkout, today, reason } = constraints;
  if (!raw || !Array.isArray(raw.days)) return null;

  // 1. Parse + clamp brut de chaque jour proposé par Groq, indexé par DATE
  //    (jamais par position dans le tableau -- Groq peut renvoyer un ordre
  //    différent, des doublons, ou des dates hors plan). En cas de doublon,
  //    la première occurrence valide gagne.
  const parsedByDate = new Map();
  for (const d of raw.days) {
    const date = String((d && d.date) || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    let sets = Array.isArray(d && d.sets)
      ? d.sets.map(n => clamp(Math.round(Number(n) || 0), 2, perSetCap)).filter(Boolean)
      : [];
    sets = fixUnevenDistribution(sets, perSetCap);
    let total = sets.reduce((a, b) => a + b, 0);
    if (total > dailyTotalCap && total > 0) {
      const factor = dailyTotalCap / total;
      sets = sets.map(v => clamp(Math.round(v * factor), 2, perSetCap));
    }
    if (!(sets.length === 0 || (sets.length >= 2 && sets.length <= 8))) continue; // forme invalide -> ignoré, reconstruit à l'étape 2
    const restSeconds = clamp(Math.round(Number(d && d.restSeconds) || 60), 30, 300);
    const note = String((d && d.note) || '').slice(0, 200);
    if (!parsedByDate.has(date)) parsedByDate.set(date, { date, sets, restSeconds, note });
  }

  // 2. Reconstruit EXACTEMENT 5 jours consécutifs à partir de `today`. Toute
  //    date manquante, dupliquée ou de forme invalide est reconstruite par le
  //    générateur déterministe -- jamais laissée vide ou absente. Les jours
  //    valides proposés par Groq sont conservés tels quels.
  const days = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(today); d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const fromGroq = parsedByDate.get(iso);
    days.push(fromGroq || { date: iso, sets: buildNormalTrainingDaySets(maxReps, i, ratio, perSetCap, dailyTotalCap, reason), restSeconds: 60, note: 'Adaptation progressive' });
  }

  // 3. Force le jour de repos obligatoire (écrase tout ce que Groq y avait mis),
  //    et neutralise tout repos NON autorisé que Groq aurait inventé ailleurs
  //    (remplacé par un jour d'entraînement déterministe, jamais laissé vide).
  for (let i = 0; i < 5; i++) {
    if (i === forcedRestDayIndex) {
      days[i] = { date: days[i].date, sets: [], restSeconds: 0, note: FORCED_REST_NOTE };
    } else if (days[i].sets.length === 0) {
      days[i] = { date: days[i].date, sets: buildNormalTrainingDaySets(maxReps, i, ratio, perSetCap, dailyTotalCap, reason), restSeconds: 60, note: 'Adaptation progressive' };
    }
  }

  // 4. NEEDS_RECOVERY : jour 0 TOUJOURS remplacé par la séance de récupération
  //    déterministe, quel que soit ce que Groq avait proposé -- Groq ne peut
  //    ni la supprimer, ni la modifier, ni la déplacer.
  const isNeedsRecoveryDay0 = !!(classification && classification.state === 'NEEDS_RECOVERY' && forcedRestDayIndex !== 0);
  if (isNeedsRecoveryDay0) {
    days[0] = {
      date: days[0].date,
      sets: buildRecoverySessionSets(maxReps, lastPlanWorkout, perSetCap, ratio, dailyTotalCap),
      restSeconds: RECOVERY_SESSION_REST_SECONDS,
      note: RECOVERY_SESSION_NOTE
    };
  }

  // 5. Garde de continuité inter-plan : jour 0, appliquée ICI (avant le
  //    lissage, pas après) pour que le lissage du jour 1 se base sur la
  //    valeur FINALE du jour 0, jamais sur une valeur bientôt remplacée.
  //    Mêmes bornes déjà validées : +20% / -30% standard / -50% NEEDS_RECOVERY
  //    / inactive au-delà de 21 jours ou sans séance Plan réelle.
  if (forcedRestDayIndex !== 0) {
    days[0].sets = applyContinuityGuard(days[0].sets, lastPlanWorkout, daysSinceLastPlanWorkout, classification ? classification.state : null, perSetCap);
  }

  // 6. Lissage jour-à-jour ±10% (comportement existant, inchangé dans sa
  //    logique) -- avec UNE exception nécessaire : si le jour 0 est une séance
  //    de récupération (volontairement très réduite), le jour 1 ne doit PAS
  //    être tiré vers le bas par la règle ±10% comme s'il s'agissait d'une
  //    progression normale -- même principe que l'exception déjà existante
  //    pour un jour de repos (total<=0 -> pas de lissage), étendue au jour 0
  //    exceptionnel.
  for (let i = 1; i < days.length; i++) {
    if (i === 1 && isNeedsRecoveryDay0) continue;
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

function buildPrompt(payload, constraints) {
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
${constraints && constraints.forcedRestDayIndex >= 0 ? `\nIMPORTANT : le jour à l'index ${constraints.forcedRestDayIndex} (0=aujourd'hui) DOIT être un jour de repos imposé ("sets":[]) — c'est déjà décidé, ne le remets pas en question.` : ''}${constraints && constraints.classification && constraints.classification.state === 'NEEDS_RECOVERY' && constraints.forcedRestDayIndex !== 0 ? `\nIMPORTANT : l'état de fatigue détecté est sévère (NEEDS_RECOVERY) — le jour 0 sera de toute façon remplacé par une séance de récupération légère, ne propose pas un volume élevé pour ce jour.` : ''}

Génère le plan des 5 prochains jours en JSON uniquement, selon le schéma donné.`;

  return { system, user };
}

// Note : les indications ci-dessus dérivées de `constraints` sont purement
// INFORMATIVES pour Groq — elles n'ont aucune valeur de sécurité. Le contrôle
// réel est entièrement assuré en aval par normalizeAndValidatePlanV2(), qui
// n'accorde aucune confiance à ce que Groq a effectivement produit.
async function generatePlanWithGroq(payload) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not configured');
  const model = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
  const constraints = computeCoachConstraints(payload);
  const { system, user } = buildPrompt(payload, constraints);

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
    const plan = normalizeAndValidatePlanV2(parsed, constraints);
    if (!plan) throw new Error('Groq API returned an invalid plan shape');
    return plan;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------- PerformanceSnapshot / classifyCoachState (coeur d'analyse Coach V2) ----------
// Fonctions PURES, déterministes, sans appel réseau ni écriture. Leur sortie
// (classification, seuils, effets) pilote directement les deux chemins de
// génération : computeCoachConstraints() les appelle et en dérive le ratio,
// forcedRestDayIndex et les paramètres passés à makeRuleBasedPlan() et à
// normalizeAndValidatePlanV2() (chemin LLM) — voir plus haut dans ce fichier.
// Exposées aussi via module.exports en fin de section, pour être testées
// depuis un script de test externe (ce fichier continue de démarrer un serveur
// HTTP normalement quand exécuté directement via `node pushup-backend-nodejs-free.js`).

const SNAPSHOT_MS_DAY = 86400000;
const SNAPSHOT_WINDOW_DAYS = 42;   // fenêtre "récente" pour adherence/completion/volumeTrend/planVsFree
const SNAPSHOT_WEEKS = 6;          // 6 blocs de 7 jours = 42 jours
const SNAPSHOT_DIFFICULTY_HALF_LIFE_DAYS = 10;

function snapshotIsoFromMs(ms) { return new Date(ms).toISOString().slice(0, 10); }
function snapshotMsFromIso(iso) { return Date.parse(iso + 'T00:00:00Z'); }
function snapshotDaysBetween(aIso, bIso) { return Math.round((snapshotMsFromIso(bIso) - snapshotMsFromIso(aIso)) / SNAPSHOT_MS_DAY); }
function snapshotAvg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

function snapshotLinRegSlope(values) {
  // values[i] correspond à x=i (0..n-1), pente des moindres carrés
  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = snapshotAvg(values);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - xMean) * (values[i] - yMean); den += (i - xMean) * (i - xMean); }
  return den === 0 ? 0 : num / den;
}

// history : tableau au format context.history (voir index.html, buildPlanHistorySnapshot()).
// profile : context.profile ({maxReps, days, startDate, ...}).
// referenceDateIso : date d'ancrage "YYYY-MM-DD" ; DOIT être fournie par l'appelant
// pour que la fonction reste déterministe (aucune dépendance à l'heure système ici).
function buildPerformanceSnapshot(history, profile, referenceDateIso) {
  const refMs = snapshotMsFromIso(referenceDateIso);
  const planStartMs = profile && profile.startDate ? Date.parse(profile.startDate) : null;
  const h = Array.isArray(history) ? history : [];

  // ---- weeklyVolumes (6 blocs de 7 jours glissants, se terminant hier) ----
  const bucketsMostRecentFirst = [];
  for (let w = 0; w < SNAPSHOT_WEEKS; w++) {
    const end = refMs - w * 7 * SNAPSHOT_MS_DAY;       // exclusif
    const start = end - 7 * SNAPSHOT_MS_DAY;           // inclusif
    const valid = planStartMs === null || start >= planStartMs;
    let planVolume = 0, freeVolume = 0, planSessions = 0, freeSessions = 0;
    for (const e of h) {
      const ms = snapshotMsFromIso(e.isoDate);
      if (ms >= start && ms < end) {
        if (e.source === 'plan' && !e.skipped) { planVolume += e.total; planSessions++; }
        else if (e.source === 'free') { freeVolume += e.total; freeSessions++; }
      }
    }
    bucketsMostRecentFirst.push({ weekStart: snapshotIsoFromMs(start), weekEnd: snapshotIsoFromMs(end - SNAPSHOT_MS_DAY), planVolume, freeVolume, planSessions, freeSessions, valid });
  }
  const weeklyVolumes = bucketsMostRecentFirst.slice().reverse(); // oldest -> newest

  // ---- volumeTrend ----
  // Garde anti-"reprise après longue pause" : si plus de la moitié des blocs
  // valides sont totalement vides (0 séance Plan), la régression linéaire sur
  // ces valeurs devient statistiquement instable (une seule semaine non-nulle
  // peut faire basculer la pente dans n'importe quel sens sans rapport avec
  // une vraie tendance de performance) -> on ne calcule pas volumeTrend du
  // tout dans ce cas plutôt que de renvoyer une valeur trompeuse.
  const validForTrend = weeklyVolumes.filter(b => b.valid);
  let volumeTrend = null;
  const emptyValidWeeks = validForTrend.filter(b => b.planVolume === 0).length;
  if (validForTrend.length >= 3 && emptyValidWeeks <= Math.floor(validForTrend.length / 2)) {
    const vols = validForTrend.map(b => b.planVolume);
    const slope = snapshotLinRegSlope(vols);
    const mean = snapshotAvg(vols);
    volumeTrend = mean > 0 ? slope / mean : (vols.every(v => v === 0) ? 0 : null);
  }

  // ---- recentReengagement ----
  // Détecte spécifiquement le motif "reprise après une pause" : les 2 blocs
  // valides les plus récents ont de l'activité Plan, ET au moins 2 blocs
  // valides plus anciens dans la même fenêtre étaient totalement vides. Sert
  // à empêcher REGRESSION de se déclencher sur la seule base d'une pause
  // passée alors que l'utilisateur est concrètement reparti depuis peu.
  let recentReengagement = false;
  if (validForTrend.length >= 4) {
    const chronological = validForTrend; // déjà du plus ancien au plus récent
    const lastTwo = chronological.slice(-2);
    const older = chronological.slice(0, -2);
    const lastTwoActive = lastTwo.every(b => b.planSessions >= 1);
    const olderEmptyCount = older.filter(b => b.planSessions === 0).length;
    recentReengagement = lastTwoActive && olderEmptyCount >= 2;
  }

  // ---- fenêtre commune (adherence / completion / planVsFree) ----
  const windowStartRaw = refMs - SNAPSHOT_WINDOW_DAYS * SNAPSHOT_MS_DAY;
  const effectiveStart = planStartMs !== null ? Math.max(windowStartRaw, planStartMs) : windowStartRaw;

  // ---- adherenceRate ----
  let adherenceRate = null;
  if (profile && Array.isArray(profile.days) && profile.days.length) {
    const expectedDates = [];
    for (let d = effectiveStart; d < refMs; d += SNAPSHOT_MS_DAY) {
      const dow = new Date(d).getUTCDay();
      if (profile.days.includes(dow)) expectedDates.push(d);
    }
    if (expectedDates.length) {
      const completedSet = new Set(
        h.filter(e => e.source === 'plan' && !e.skipped && snapshotMsFromIso(e.isoDate) >= effectiveStart && snapshotMsFromIso(e.isoDate) < refMs)
         .map(e => e.isoDate)
      );
      const completedCount = expectedDates.filter(d => completedSet.has(snapshotIsoFromMs(d))).length;
      adherenceRate = clamp(completedCount / expectedDates.length, 0, 1);
    }
  }

  // ---- completionRatio ----
  const completionEligible = h.filter(e => e.source === 'plan' && !e.skipped && e.target !== null && e.target > 0
    && snapshotMsFromIso(e.isoDate) >= effectiveStart && snapshotMsFromIso(e.isoDate) < refMs);
  const completionRatio = completionEligible.length
    ? snapshotAvg(completionEligible.map(e => clamp(e.total / e.target, 0, 1.5)))
    : null;

  // ---- intraSessionDropoff (5 dernières séances Plan éligibles, historique complet) ----
  const dropoffEligible = h.filter(e => e.source === 'plan' && !e.skipped && Array.isArray(e.sets) && e.sets.length >= 2 && e.sets[0].reps > 0)
    .sort((a, b) => b.isoDate.localeCompare(a.isoDate)).slice(0, 5);
  const intraSessionDropoff = dropoffEligible.length
    ? snapshotAvg(dropoffEligible.map(e => clamp(e.sets[e.sets.length - 1].reps / e.sets[0].reps, 0, 2)))
    : null;

  // ---- difficultyTrend (10 dernières séances Plan avec difficulty, pondération demi-vie 10j) ----
  const difficultyEligible = h.filter(e => e.source === 'plan' && !e.skipped && e.difficulty)
    .sort((a, b) => b.isoDate.localeCompare(a.isoDate)).slice(0, 10);
  let difficultyTrend = null;
  if (difficultyEligible.length) {
    const severity = d => d === 'hard' ? 1 : d === 'easy' ? -1 : 0;
    let wSum = 0, sSum = 0;
    for (const e of difficultyEligible) {
      const daysAgo = snapshotDaysBetween(e.isoDate, referenceDateIso);
      const weight = Math.pow(0.5, daysAgo / SNAPSHOT_DIFFICULTY_HALF_LIFE_DAYS);
      wSum += weight; sSum += weight * severity(e.difficulty);
    }
    difficultyTrend = wSum > 0 ? sSum / wSum : null;
  }

  // ---- consecutiveStreak (identique à computeConsecutiveTrainingStreak ci-dessus, historique complet) ----
  const streakDates = [...new Set(h.filter(e => !e.skipped).map(e => e.isoDate))].sort();
  let consecutiveStreak = 0;
  if (streakDates.length) {
    consecutiveStreak = 1;
    for (let i = streakDates.length - 1; i > 0; i--) {
      const diff = snapshotDaysBetween(streakDates[i - 1], streakDates[i]);
      if (diff <= 1) consecutiveStreak++; else break;
    }
  }

  // ---- planVsFreeVolume (même fenêtre 42j) ----
  const windowEntries = h.filter(e => snapshotMsFromIso(e.isoDate) >= effectiveStart && snapshotMsFromIso(e.isoDate) < refMs);
  const planVolume = windowEntries.filter(e => e.source === 'plan' && !e.skipped).reduce((a, e) => a + e.total, 0);
  const freeVolume = windowEntries.filter(e => e.source === 'free').reduce((a, e) => a + e.total, 0);
  const planSessionsW = windowEntries.filter(e => e.source === 'plan' && !e.skipped).length;
  const freeSessionsW = windowEntries.filter(e => e.source === 'free').length;
  const planVsFreeVolume = {
    planVolume, freeVolume, planSessions: planSessionsW, freeSessions: freeSessionsW,
    planSharePct: (planVolume + freeVolume) > 0 ? planVolume / (planVolume + freeVolume) : null
  };

  // ---- recentPerformance (3 dernières séances Plan, historique complet) ----
  const recentPlan = h.filter(e => e.source === 'plan' && !e.skipped).sort((a, b) => b.isoDate.localeCompare(a.isoDate)).slice(0, 3);
  const recentCompletionRatios = recentPlan.filter(e => e.target !== null && e.target > 0).map(e => clamp(e.total / e.target, 0, 1.5));
  const recentDropoffs = recentPlan.filter(e => Array.isArray(e.sets) && e.sets.length >= 2 && e.sets[0].reps > 0).map(e => clamp(e.sets[e.sets.length - 1].reps / e.sets[0].reps, 0, 2));
  const recentPerformance = {
    sessionsConsidered: recentPlan.length,
    avgTotal: recentPlan.length ? snapshotAvg(recentPlan.map(e => e.total)) : null,
    avgCompletionRatio: recentCompletionRatios.length ? snapshotAvg(recentCompletionRatios) : null,
    avgDropoff: recentDropoffs.length ? snapshotAvg(recentDropoffs) : null,
    difficulties: recentPlan.map(e => e.difficulty)
  };

  // ---- lastPlanWorkout / daysSinceLastPlanWorkout ----
  const lastPlanWorkout = recentPlan.length ? recentPlan[0] : null;
  const daysSinceLastPlanWorkout = lastPlanWorkout ? snapshotDaysBetween(lastPlanWorkout.isoDate, referenceDateIso) : null;

  const sampleSize = {
    planSessions: h.filter(e => e.source === 'plan' && !e.skipped).length,
    freeSessions: h.filter(e => e.source === 'free').length,
    difficultyLabeled: h.filter(e => e.source === 'plan' && !e.skipped && e.difficulty).length
  };

  return {
    referenceDate: referenceDateIso,
    windowDays: SNAPSHOT_WINDOW_DAYS,
    sampleSize,
    adherenceRate,
    completionRatio,
    volumeTrend,
    weeklyVolumes,
    intraSessionDropoff,
    difficultyTrend,
    consecutiveStreak,
    recentReengagement,
    planVsFreeVolume,
    recentPerformance,
    lastPlanWorkout,
    daysSinceLastPlanWorkout
  };
}

// ---------------- Seuils (validés par simulation, voir échanges de conception) ----------------
const COACH_STATE_THRESHOLDS = {
  STREAK_CRITICAL: 6,
  STREAK_WARNING: 4,
  DIFFICULTY_CRITICAL: 0.5,
  DIFFICULTY_WARNING: 0.25,
  DROPOFF_CRITICAL: 0.65,
  DROPOFF_WARNING: 0.80,
  COMPLETION_LOW_FOR_RECOVERY: 0.85,
  VOLUME_REGRESSION: -0.10,
  COMPLETION_REGRESSION: 0.75,
  ADHERENCE_REGRESSION: 0.50,
  STAGNATION_ADHERENCE_MIN: 0.70,
  STAGNATION_VOLUME_BAND: 0.03,
  STAGNATION_COMPLETION_MIN: 0.85,
  PROGRESSING_VOLUME_MIN: 0.05,
  PROGRESSING_COMPLETION_MIN: 0.85,
  PROGRESSING_DIFFICULTY_MAX: 0.25
};

const COACH_STATE_MIN_SAMPLE_FOR_TREND = 3; // en dessous, regression/stagnation/progression ne sont pas fiables

// Effet/repos par (état, sévérité) — documentation uniquement à ce stade, non lu
// par le générateur de plan.
const COACH_STATE_EFFECTS = {
  PROGRESSING: { progressionEffect: 'increase', forcedRest: false },
  STABLE: { progressionEffect: 'neutral', forcedRest: false },
  STAGNATION: { progressionEffect: 'push', forcedRest: false },
  REGRESSION: { progressionEffect: 'freeze_or_cut', forcedRest: false },
  FATIGUE_RISK_watch: { progressionEffect: 'cautious_increase', forcedRest: false },
  FATIGUE_RISK_confirmed: { progressionEffect: 'reduce', forcedRest: false },
  NEEDS_RECOVERY: { progressionEffect: 'reduce_sharply', forcedRest: true }
};

// snapshot : objet renvoyé par buildPerformanceSnapshot(). Renvoie
// {state, severity, confidence, reasons, progressionEffect, forcedRest}.
// États possibles : PROGRESSING, STABLE, STAGNATION, REGRESSION, FATIGUE_RISK, NEEDS_RECOVERY.
function classifyCoachState(s) {
  const T = COACH_STATE_THRESHOLDS;
  const reasons = [];

  // Priorité 0 : aucune séance Plan jamais enregistrée -> rien à détecter, état
  // neutre par construction (même logique que reason==='initial' côté coach
  // actuel, qui ne tente déjà aucune détection sur un plan tout juste créé).
  if (s.sampleSize.planSessions === 0) {
    reasons.push(s.sampleSize.freeSessions > 0 ? 'no_plan_sessions_recorded (free sessions only)' : 'no_plan_sessions_recorded');
    return finalizeCoachState('STABLE', s, reasons, null);
  }

  // ---- NEEDS_RECOVERY (priorité maximale, jamais masqué par de bons chiffres) ----
  if (s.consecutiveStreak >= T.STREAK_CRITICAL) { reasons.push(`consecutiveStreak(${s.consecutiveStreak})>=${T.STREAK_CRITICAL}`); return finalizeCoachState('NEEDS_RECOVERY', s, reasons, null); }
  if (s.difficultyTrend !== null && s.difficultyTrend >= T.DIFFICULTY_CRITICAL) { reasons.push(`difficultyTrend(${s.difficultyTrend.toFixed(2)})>=${T.DIFFICULTY_CRITICAL}`); return finalizeCoachState('NEEDS_RECOVERY', s, reasons, null); }
  if (s.intraSessionDropoff !== null && s.intraSessionDropoff <= T.DROPOFF_CRITICAL && s.completionRatio !== null && s.completionRatio < T.COMPLETION_LOW_FOR_RECOVERY) {
    reasons.push(`intraSessionDropoff(${s.intraSessionDropoff.toFixed(2)})<=${T.DROPOFF_CRITICAL}`, `completionRatio(${s.completionRatio.toFixed(2)})<${T.COMPLETION_LOW_FOR_RECOVERY}`);
    return finalizeCoachState('NEEDS_RECOVERY', s, reasons, null);
  }

  // ---- FATIGUE_RISK "confirmé" : un signal de PERFORMANCE (pas juste calendaire) ----
  // Un vrai signal de difficulté ou d'effondrement intra-séance prime sur un
  // simple streak, quel que soit le streak (peut valoir même à streak<4).
  if (s.difficultyTrend !== null && s.difficultyTrend >= T.DIFFICULTY_WARNING) { reasons.push(`difficultyTrend(${s.difficultyTrend.toFixed(2)})>=${T.DIFFICULTY_WARNING}`); return finalizeCoachState('FATIGUE_RISK', s, reasons, 'confirmed'); }
  if (s.intraSessionDropoff !== null && s.intraSessionDropoff <= T.DROPOFF_WARNING) { reasons.push(`intraSessionDropoff(${s.intraSessionDropoff.toFixed(2)})<=${T.DROPOFF_WARNING}`); return finalizeCoachState('FATIGUE_RISK', s, reasons, 'confirmed'); }

  // ---- FATIGUE_RISK lié au streak (4-5 jours), avec ou sans signal secondaire ----
  if (s.consecutiveStreak >= T.STREAK_WARNING) {
    // À ce stade, difficultyTrend/dropoff (moyennes sur historique complet)
    // ont déjà été testés ci-dessus et étaient soit null soit sous leur seuil.
    // Pour le signal secondaire "completion", on utilise volontairement
    // recentPerformance.avgCompletionRatio (3 dernières séances) et NON le
    // completionRatio agrégé sur 42 jours : le streak concerne par nature les
    // derniers jours, et une moyenne longue le dilue au point de ne presque
    // jamais déclencher "confirmed" même quand les séances du streak sont
    // clairement en dessous de l'objectif.
    const recentCompletion = s.recentPerformance && typeof s.recentPerformance.avgCompletionRatio === 'number' ? s.recentPerformance.avgCompletionRatio : null;
    if (recentCompletion !== null && recentCompletion < T.STAGNATION_COMPLETION_MIN) {
      reasons.push(`consecutiveStreak(${s.consecutiveStreak})>=${T.STREAK_WARNING}`, `recentPerformance.avgCompletionRatio(${recentCompletion.toFixed(2)})<${T.STAGNATION_COMPLETION_MIN}`);
      return finalizeCoachState('FATIGUE_RISK', s, reasons, 'confirmed');
    }
    reasons.push(`consecutiveStreak(${s.consecutiveStreak})>=${T.STREAK_WARNING} (seul signal, aucun autre indicateur négatif)`);
    return finalizeCoachState('FATIGUE_RISK', s, reasons, 'watch');
  }

  // ---- REGRESSION (jamais si une reprise récente après pause est détectée) ----
  if (s.volumeTrend !== null && s.volumeTrend <= T.VOLUME_REGRESSION && !s.recentReengagement) { reasons.push(`volumeTrend(${s.volumeTrend.toFixed(2)})<=${T.VOLUME_REGRESSION}`); return finalizeCoachState('REGRESSION', s, reasons, null); }
  if (s.completionRatio !== null && s.completionRatio < T.COMPLETION_REGRESSION) { reasons.push(`completionRatio(${s.completionRatio.toFixed(2)})<${T.COMPLETION_REGRESSION}`); return finalizeCoachState('REGRESSION', s, reasons, null); }
  // Gardé derrière un plancher d'échantillon : avec 1-2 séances seulement, un
  // ratio séances-faites/séances-prévues est arithmétiquement vrai mais ne
  // reflète pas encore une vraie "régression" (juste un début de plan).
  if (s.sampleSize.planSessions >= COACH_STATE_MIN_SAMPLE_FOR_TREND && s.adherenceRate !== null && s.adherenceRate < T.ADHERENCE_REGRESSION && !s.recentReengagement) { reasons.push(`adherenceRate(${s.adherenceRate.toFixed(2)})<${T.ADHERENCE_REGRESSION}`); return finalizeCoachState('REGRESSION', s, reasons, null); }

  if (s.sampleSize.planSessions >= COACH_STATE_MIN_SAMPLE_FOR_TREND
    && s.adherenceRate !== null && s.adherenceRate >= T.STAGNATION_ADHERENCE_MIN
    && s.volumeTrend !== null && Math.abs(s.volumeTrend) < T.STAGNATION_VOLUME_BAND
    && s.completionRatio !== null && s.completionRatio >= T.STAGNATION_COMPLETION_MIN) {
    reasons.push(`adherenceRate(${s.adherenceRate.toFixed(2)})>=${T.STAGNATION_ADHERENCE_MIN}`, `|volumeTrend|(${Math.abs(s.volumeTrend).toFixed(2)})<${T.STAGNATION_VOLUME_BAND}`, `completionRatio(${s.completionRatio.toFixed(2)})>=${T.STAGNATION_COMPLETION_MIN}`);
    return finalizeCoachState('STAGNATION', s, reasons, null);
  }

  if (s.sampleSize.planSessions >= COACH_STATE_MIN_SAMPLE_FOR_TREND
    && s.volumeTrend !== null && s.volumeTrend >= T.PROGRESSING_VOLUME_MIN
    && s.completionRatio !== null && s.completionRatio >= T.PROGRESSING_COMPLETION_MIN
    && (s.difficultyTrend === null || s.difficultyTrend < T.PROGRESSING_DIFFICULTY_MAX)) {
    reasons.push(`volumeTrend(${s.volumeTrend.toFixed(2)})>=${T.PROGRESSING_VOLUME_MIN}`, `completionRatio(${s.completionRatio.toFixed(2)})>=${T.PROGRESSING_COMPLETION_MIN}`);
    return finalizeCoachState('PROGRESSING', s, reasons, null);
  }

  reasons.push('no rule matched (defaut neutre)');
  return finalizeCoachState('STABLE', s, reasons, null);
}

function finalizeCoachState(state, s, reasons, severity) {
  let confidence = 'medium';
  if (s.sampleSize.planSessions === 0) confidence = 'low';
  else if (s.sampleSize.planSessions >= 6 && s.adherenceRate !== null && s.volumeTrend !== null) confidence = 'high';
  else if (s.sampleSize.planSessions < 3) confidence = 'low';
  const effectKey = state === 'FATIGUE_RISK' ? `FATIGUE_RISK_${severity}` : state;
  const { progressionEffect, forcedRest } = COACH_STATE_EFFECTS[effectKey];
  return { state, severity, confidence, reasons, progressionEffect, forcedRest };
}

// Exposition pour des scripts de test externes uniquement (aucun fichier de ce
// dépôt ne fait require() de ce module — exécuté directement, ce fichier
// démarre toujours le serveur HTTP normalement). N'affecte pas le contrat API
// envoyé à index.html : generatePlanWithGroq()/makeRuleBasedPlan() appellent
// ces fonctions directement, pas via cet export.
module.exports = { buildPerformanceSnapshot, classifyCoachState, COACH_STATE_THRESHOLDS };

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
