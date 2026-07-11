// Patch à ajouter dans ton front-end
const AI_PLAN_API_URL = 'https://pushup-plan-api.onrender.com/api/plan/generate';

async function regeneratePlanFromAI(reason='regular'){
  if(!planProfile) return null;
  const payload = {
    reason,
    context: {
      profile: planProfile,
      recent: getRecentPlanWorkouts(14),
      skipped: workouts.filter(w=>w && w.source==='plan' && w.skipped===true),
      today: new Date().toISOString().slice(0,10)
    }
  };
  const res = await fetch(AI_PLAN_API_URL, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  if(!res.ok) return null;
  const ai = await res.json();
  if(!ai || !Array.isArray(ai.days)) return null;
  planProfile.aiPlan = ai;
  savePlan(planProfile);
  return ai;
}
