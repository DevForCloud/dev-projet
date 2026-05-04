# TP — Stress test avec k6 — notes

## Objectif

Observer le comportement de TaskFlow sous charge et identifier le goulot d'etranglement avec k6 pour la latence end-to-end et Grafana pour les metriques par service.

## Prerequis corriges

- Application: `docker compose up --build`
- Infrastructure: `docker compose -f docker-compose.infra.yml up`
- Stack complete: `docker compose -f docker-compose.yml -f docker-compose.infra.yml up --build`
- Grafana: http://localhost:3100 dans ce projet, car `docker-compose.infra.yml` publie Grafana avec `3100:3000`.
- API Gateway: http://localhost:3000
- Script leger: `scripts/load-test-light.js`
- Script realiste: `scripts/load-test-realistic.js`

## Etape 1 — Test leger

### Commande

```bash
k6 run -e TOKEN=<votre_token> scripts/load-test-light.js
```

Le script leger envoie une requete `GET /api/tasks` par iteration via l'API Gateway. Le `BASE_URL` par defaut a ete aligne sur `http://localhost:3000`.

### Question 1

La latence p95 doit etre lue dans le resume terminal k6, ligne `http_req_duration`.

Resultat observe:

```text
A completer apres execution k6.
```

Interpretation attendue: si `p(95) < 200ms`, le test leger reste dans le seuil acceptable demande.

### Question 2

Le taux `http_req_failed` doit etre lu dans le resume terminal k6.

Resultat observe:

```text
A completer apres execution k6.
```

Interpretation attendue: `0.00%` signifie qu'aucune requete HTTP n'a echoue. Si le taux n'est pas nul, regarder les checks et les statuts HTTP retournes.
