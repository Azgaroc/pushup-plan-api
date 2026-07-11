# Push-up Plan API

API Node.js gratuite pour générer un plan de pompes adaptatif.

## Dépendances

```bash
npm install
```

## Lancer

```bash
npm start
```

## Variables d'environnement

- `PORT` : port du serveur, défaut `3000`
- `FREE_MODEL_NAME` : modèle open-source utilisé par défaut, défaut `Qwen2.5-3B-Instruct`

## Routes

### GET /api/health

Retourne l'état du service.

### POST /api/plan/generate

Exemple de payload :

```json
{
  "reason": "regular",
  "context": {
    "profile": {
      "maxReps": 20,
      "days": [1,3,5],
      "aiPlan": null
    },
    "recent": [],
    "skipped": [],
    "today": "2026-07-11"
  }
}
```

Réponse attendue :

```json
{
  "version": 1,
  "generatedAt": "2026-07-11T08:00:00.000Z",
  "days": [
    {
      "date": "2026-07-11",
      "sets": [12,13,12,10],
      "restSeconds": 90,
      "note": "Adaptation progressive"
    }
  ]
}
```

## Déploiement GitHub

1. Crée un repo GitHub.
2. Ajoute `package.json`, `pushup-backend-nodejs-free.js`, `frontend-patch.js`, `.gitignore` et ce `README.md`.
3. Commit et push.
4. Déploie ensuite sur une plateforme gratuite compatible Node.js.

## Commit recommandé

```bash
git commit -m "Initial free adaptive push-up plan API"
```
