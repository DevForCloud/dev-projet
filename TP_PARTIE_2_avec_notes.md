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

## Etape 2 — Montee en charge progressive

### Commandes

Scenario par defaut:

```bash
k6 run -e EMAIL=<email> -e PASSWORD=<password> scripts/load-test-realistic.js
```

Scenario plus fort pour identifier le seuil de rupture:

```bash
HIGH_VUS=100 k6 run -e EMAIL=<email> -e PASSWORD=<password> scripts/load-test-realistic.js
HIGH_VUS=200 k6 run -e EMAIL=<email> -e PASSWORD=<password> scripts/load-test-realistic.js
```

Le script realiste envoie, a chaque iteration complete:

- 1 requete `POST /api/users/login`
- 1 requete `GET /api/tasks`
- 1 requete `POST /api/tasks`
- 1 requete `GET /api/notifications`

Toutes ces requetes passent par `api-gateway`.

### Question 3

Dans le resume k6, il faut regarder:

- `checks_failed`
- `http_req_duration`
- le check nomme `tasks response < 500ms`

Resultat observe:

```text
A completer apres execution k6.
```

Interpretation attendue: le stade a reporter est le premier niveau de VUs ou le check `tasks response < 500ms` commence a echouer massivement. La p95 finale est la valeur `p(95)` de `http_req_duration` dans le resume terminal k6, pas la latence Grafana.

### Question 4

Au pic de charge, `api-gateway` recoit plus de trafic car il est le point d'entree unique. Chaque iteration du scenario realiste fait 4 appels HTTP vers `api-gateway`.

Repartition par service applicatif:

- `api-gateway`: 4 requetes par iteration
- `user-service`: 1 requete par iteration, pour le login
- `task-service`: 2 requetes par iteration, pour lister puis creer une tache
- `notification-service`: 1 requete par iteration, pour lire les notifications

C'est pour cela que `api-gateway` recoit environ 2 fois plus de trafic que `task-service`, et environ 4 fois plus que `user-service`.

### Question 5

Le `task-service` est plus impacte parce qu'il recoit deux appels par iteration et parce que son endpoint de creation fait plus de travail qu'une simple lecture:

- insertion PostgreSQL
- mise a jour des metriques metier
- recalcul du gauge `tasks_gauge`
- publication Redis `task.created`
- generation d'une trace avec span custom autour de la publication

Le `user-service` ne gere qu'un login par iteration, et le `notification-service` ne fait qu'une lecture en memoire dans cette implementation. Le `task-service` combine donc plus de trafic et plus d'I/O.

## Etape 3 — Limites de `docker scale`

### Manipulation 1

Commande:

```bash
docker compose up --scale task-service=3
```

### Question 6

Avec la configuration initiale, Docker Compose echoue car `task-service` publie un port hote fixe:

```yaml
ports:
  - "3002:3002"
```

Quand on demande 3 replicas, chaque conteneur essaie de publier le port hote `3002`. Un seul conteneur peut ecouter ce port sur la machine hote, donc les autres replicas ne peuvent pas demarrer.

Erreur typique:

```text
Bind for 0.0.0.0:3002 failed: port is already allocated
```

Ligne responsable: `docker-compose.yml`, service `task-service`, section `ports`.

### Manipulation 2

Le contournement consiste a ne plus publier `task-service` directement sur l'hote. Le service reste accessible dans le reseau Docker par `task-service:3002`, ce qui suffit pour `api-gateway` et Prometheus.

Configuration appliquee:

```yaml
task-service:
  expose:
    - "3002"
```

Commande:

```bash
docker compose up --scale task-service=3
```

### Question 7

Le scaling peut ameliorer partiellement la capacite du `task-service`, mais il ne rend pas l'architecture propre pour autant.

Dans Grafana, le trafic peut continuer a apparaitre sous un seul job `task-service`, car les metriques Prometheus sont scrapees via la cible statique `task-service:3002`.

Dans Prometheus sur http://localhost:9090/targets, on voit toujours une seule target pour le job `task-service`:

```text
task-service:3002
```

Prometheus ne voit donc pas 3 targets distinctes. La configuration actuelle ne connait pas les noms ou adresses individuelles des replicas. Elle ne fait qu'interroger le nom DNS Compose du service.

Pour monitorer chaque replica individuellement, il faudrait une decouverte de services qui expose chaque instance comme target separee, ou une configuration generee dynamiquement.

### Question 8

`docker scale` ne suffit pas pour un scaling propre en production parce qu'il ne fournit pas tout ce qui est necessaire autour du simple demarrage de plusieurs conteneurs:

- pas de service discovery robuste pour l'observabilite par replica
- pas de load balancing applicatif explicite et controle
- pas de rolling update propre
- pas d'autoscaling
- pas de rescheduling automatique avance en cas de panne
- pas de configuration native des probes de readiness/liveness comparable a Kubernetes

Kubernetes apporte des `Deployments` pour gerer les replicas, des `Services` pour exposer un point d'entree stable avec load balancing, des probes, du rolling update, du service discovery, et une integration beaucoup plus propre avec Prometheus via des mecanismes de decouverte.
