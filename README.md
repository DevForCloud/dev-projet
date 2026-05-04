# TaskFlow — TP Cloud & DevOps

Architecture multi-services pour apprendre Kubernetes, l'observabilité et le CI/CD.

## Services applicatifs

| Service | Port | Rôle |
|---|---:|---|
| api-gateway | 3000 | Point d'entrée unique, auth JWT, proxy vers les services |
| user-service | 3001 | Gestion des utilisateurs, inscription et connexion |
| task-service | 3002 | CRUD des tâches |
| notification-service | 3003 | Notifications via Redis Pub/Sub |
| frontend | 5173 | Interface React |

## Infrastructure

| Outil | Port hôte | Rôle |
|---|---:|---|
| PostgreSQL | 5432 | Base de données principale |
| Redis | 6379 | Bus de messages entre services |
| Prometheus | 9090 | Collecte et requêtes de métriques |
| Grafana | 3100 | Visualisation métriques, logs et traces |
| Tempo | 3200 | Stockage et exploration des traces |
| Loki | 3101 | API Loki exposée côté hôte, port 3100 dans Docker |
| OTel Collector | 4317 / 4318 / 8888 | Réception OTLP, export traces, métriques internes |

## Prérequis

- Docker et Docker Compose
- Node.js et npm
- Un fichier `.env` à la racine du projet

Exemple minimal de `.env` :

```env
REDIS_URL=redis://redis:6379
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
DATABASE_URL=postgresql://taskflow:taskflow@postgres:5432/taskflow
JWT_SECRET=dev-secret

POSTGRES_USER=taskflow
POSTGRES_PASSWORD=taskflow
POSTGRES_DB=taskflow

USER_SERVICE_PORT=3001
USER_SERVICE_URL=http://user-service:3001
USER_SERVICE_OTEL_SERVICE_NAME=user-service

TASK_SERVICE_PORT=3002
TASK_SERVICE_URL=http://task-service:3002
TASK_SERVICE_OTEL_SERVICE_NAME=task-service

NOTIFICATION_SERVICE_PORT=3003
NOTIFICATION_SERVICE_URL=http://notification-service:3003
NOTIFICATION_SERVICE_OTEL_SERVICE_NAME=notification-service

API_GATEWAY_PORT=3000
API_GATEWAY_URL=http://api-gateway:3000
API_GATEWAY_OTEL_SERVICE_NAME=api-gateway
```

## Démarrage

Installer les dépendances et générer les lockfiles :

```bash
npm run install:all
```

Lancer l'application :

```bash
npm run dev
```

Lancer l'infrastructure d'observabilité :

```bash
npm run dev:infra
```

Arrêter les conteneurs :

```bash
docker compose down
docker compose -f docker-compose.infra.yml down
```

## URLs utiles

| Interface | URL |
|---|---|
| Frontend | http://localhost:5173 |
| API Gateway | http://localhost:3000 |
| User service metrics | http://localhost:3001/metrics |
| Task service metrics | http://localhost:3002/metrics |
| Notification service metrics | http://localhost:3003/metrics |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3100 |
| Tempo | http://localhost:3200 |
| Loki ready check | http://localhost:3101/ready |

Connexion Grafana :

```text
login: admin
password: admin
```
## Questions 
### B. Visualisation de l'application
##### Compréhension

Réalisez le scénario suivant et documentez ce que vous observez :

- Faire une requête POST `/api/tasks` depuis le frontend
- Retrouver la trace dans Grafana > Explore > Tempo
- Identifier la chaîne de spans (api-gateway → task-service → postgres)
- Commenter, expliquer les attributs (http.method, http.route, db.statement, etc ...)

![alt text](./images/Screenshot%20from%202026-04-14%2011-21-43.png)

Response: 
Après avoir créé une tâche depuis le frontend, on a retrouvé la trace en filtrant sur le service `api-gateway` et la route `POST /api/tasks`.

La trace montre la chaîne de spans suivante :

- `api-gateway` reçoit la requête HTTP `POST /api/tasks` et transmet ensuite la requête vers `task-service` via HTTP, ce qui génère un nouveau span dans `task-service` avec la route `/tasks`.
- `task-service` reçoit la requête et exécute une requête SQL pour insérer la tâche en base de données.

Les attributs observés permettent de comprendre le chemin de la requête :

Par exemple pour api-gateway POST /api/tasks :
```
| Attribut | Valeur |
|---|---|
| `http.flavor` | `"1.1"` |
| `http.host` | `"localhost"` |
| `http.method` | `"POST"` |
| `http.request_content_length_uncompressed` | `195` |
| `http.route` | `"/api/tasks"` |
| `http.scheme` | `"http"` |
| `http.status_code` | `201` |
| `http.status_text` | `"CREATED"` |
| `http.target` | `"/api/tasks"` |
| `http.url` | `"http://localhost/api/tasks"` |
| `http.user_agent` | `"Mozilla/5.0 (X11; Linux x86_64; rv:149.0) Gecko/20100101 Firefox/149.0"` |
| `net.host.ip` | `"::ffff:172.24.0.7"` |
| `net.host.name` | `"localhost"` |
| `net.host.port` | `3000` |
| `net.peer.ip` | `"::ffff:172.24.0.8"` |
| `net.peer.port` | `54784` |
| `net.transport` | `"ip_tcp"` |

```
- `resource.service.name` indique le service qui a produit le span, par exemple `api-gateway` ou `task-service`.
- `http.method` vaut `POST`, ce qui correspond à la création d’une tâche.
- `http.route` indique la route traitée, par exemple `/api/tasks` côté gateway et `/tasks` côté task-service.
- `http.status_code` indique le résultat HTTP.

ensuite pour le span PostgreSQL INSERT taskflow :
```
| Attribut | Valeur |
|---|---|
| `db.connection_string` | `"postgresql://postgres:5432/taskflow"` |
| `db.name` | `"taskflow"` |
| `db.statement` | `"INSERT INTO tasks (title, description, priority, assignee_id, due_date, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *"` |
| `db.system` | `"postgresql"` |
| `db.user` | `"taskflow"` |
| `net.peer.name` | `"postgres"` |
| `net.peer.port` | `5432` |

```
- `db.connection_string` montre la chaîne de connexion utilisée pour accéder à la base de données.
- `db.name` indique le nom de la base de données utilisée, ici `taskflow`.
- `db.statement` montre la requête SQL exécutée, par exemple un `INSERT INTO tasks (...)`.
- `db.system` indique le système de base de données utilisé, ici PostgreSQL.
- `db.user` montre l’utilisateur de la base de données qui a exécuté la requête, ici `taskflow`.

Les spans HTTP montrent la propagation de la requête entre les services, tandis que le span PostgreSQL montre l’accès à la base de données.

##### Ajout de spans custom

L'auto-instrumentation couvre déjà HTTP et PostgreSQL. Redis/pub-sub n'est pas toujours auto-instrumenté.

Dans `task-service/src/routes.js`, créer un span manuel autour de la logique de publication Redis 

- Retrouver ce span dans la vue distribuée d'une trace dans Grafana

![alt text](./images/Screenshot%20from%202026-04-14%2011-54-36.png)

### C. Ajout des Logs
#### Visualisation

- Dans Grafana > Explore, sélectionner la datasource Loki, filtrer les logs du task-service uniquement.
  - Quelle syntaxe LogQL est utilisée ?

```logql
{service="task-service"}
```

  - Quelle différence y a-t-il avec une requête Prometheus ?

Prometheus interroge des métriques numériques avec PromQL, par exemple :

```promql
http_requests_total{status="500"}
```

Loki interroge des logs avec LogQL, par exemple :

```logql
{service="task-service"} |= "request failed"
```

Prometheus est plus adapté pour mesurer, agréger et alerter. Loki est plus adapté pour lire le détail des événements et comprendre les erreurs.


- Déclencher une erreur volontairement (ex: créer une tâche sans title). Retrouver le log d'erreur correspondant dans Loki.

```bash
curl -X POST http://localhost:3002/tasks \
  -H "Content-Type: application/json" \
  -d '{}'
```

  - Quelle requête utiliser pour filtrer ?

Créer une tâche sans `title` retourne un `400`, donc la requête LogQL est :

```logql
{service="task-service"} | json statusCode="res.statusCode" | statusCode = `400`
```

Pour filtrer sur le message d'échec :

```logql
{service="task-service"} |= "request failed"
```

- Écrire une requête LogQL qui affiche uniquement les logs de niveau error sur tous les services à la fois. Grâce à pino, les services loggent en JSON. Écrire une requête qui extrait et filtre sur le champ statusCode pour ne voir que les requêtes ayant retourné un 500.
  - Comparer :
    - Dans Prometheus http_requests_total{status="500"}.
    - Dans Loki, comment obtenir l'équivalent en passant par les logs ?

Logs de niveau `error` sur tous les services applicatifs :

```logql
{service=~"api-gateway|user-service|task-service|notification-service", level="error"}
```

Équivalent Loki pour les requêtes HTTP ayant retourné un `500` :

```logql
{service=~"api-gateway|user-service|task-service|notification-service"} | json statusCode="res.statusCode" | statusCode = `500`
```

Équivalent Prometheus :

```promql
http_requests_total{status="500"}
```

  - Entre ces deux approches, laquelle est la plus adaptée et pourquoi ?

Prometheus est plus adapté pour détecter et alerter sur un pic d'erreurs, car il est optimisé pour les métriques, les taux et les agrégations.

Loki est plus adapté pour investiguer le détail des erreurs : message, route, stack trace, `trace_id`, payload, etc.

- Effectuer une requête POST /api/tasks. Dans Tempo, retrouver la trace correspondante et noter son traceId.

```json
{
  "trace_id": "a22fec1964b10a76a73998c3e61b664b"
}
```

  - Peut-on retrouver ce traceId dans les logs Loki ?

Oui, si le log contient le champ `trace_id`.

```logql
{service="task-service"} |= "a22fec1964b10a76a73998c3e61b664b"
```

  - Que faudrait-il configurer pour que ce soit automatique ?

Il faut configurer les `derived fields` dans la datasource Loki de Grafana pour détecter automatiquement le champ `trace_id` et créer un lien vers Tempo.

- Mettons que l'on observe un pic d'erreurs dans le dashboard Prometheus.
  - Décrire la démarche pour investiguer : par où commencer, comment utiliser métriques, logs et traces ?

1. Identifier le service en erreur avec Prometheus :

```promql
sum by (job) (rate(http_requests_total{status=~"5.."}[5m]))
```

2. Aller dans Loki et filtrer les logs du service :

```logql
{service="task-service", level="error"}
```

3. Extraire ou copier le `trace_id` du log.

4. Aller dans Tempo et rechercher la trace avec ce `trace_id`.

5. Lire la trace pour trouver où l'erreur apparaît : `api-gateway`, `task-service`, PostgreSQL, Redis, etc.

## Partie 2 — Stress test avec k6

### Question 1 — Quelle est la latence p95 affichée par k6 pendant le test léger ? Est-elle dans les seuils acceptables (< 200ms) ?

Résultat observé :

```text
http_req_duration: avg=20.14ms min=6.8ms med=16.84ms max=44.6ms p(90)=38.9ms p(95)=42.05ms
```

La latence p95 est de `42.05ms`. Elle est donc largement inférieure au seuil demandé de `200ms`. Le test léger est acceptable.

### Question 2 — Le taux `http_req_failed` est-il à 0 % ? Si non, quel code d'erreur observez-vous ?

Résultat observé :

```text
http_req_failed: 0.00% 0 out of 150
checks_failed: 0.00% 0 out of 300
```

Le taux `http_req_failed` est bien à `0.00%`. Aucun code d'erreur HTTP n'a été observé pendant le test léger, et tous les checks sont passés.

### Question 3 — À partir de quel stade le check `tasks response < 500ms` commence-t-il à échouer massivement ? Quelle est la p95 finale ?

Résultats observés avec le script réaliste :

```text
HIGH_VUS=50:
checks_failed: 0.00% 0 out of 12528
tasks response < 500ms: 100% de succès
http_req_duration p(95)=73.52ms
http_req_failed: 0.00% 0 out of 8352

HIGH_VUS=100:
checks_failed: 7.32% 1157 out of 15804
tasks response < 500ms: 56% de succès, 1477 succès / 1157 échecs
http_req_duration p(95)=1.67s
http_req_failed: 0.00% 0 out of 10536

HIGH_VUS=200:
checks_failed: 13.03% 1712 out of 13134
tasks response < 500ms: 21% de succès, 477 succès / 1712 échecs
http_req_duration p(95)=5.2s
http_req_failed: 0.00% 0 out of 8756
```

Le check `tasks response < 500ms` commence à échouer massivement à partir de `HIGH_VUS=100`. À `50` VUs, tous les checks passent encore. À `100` VUs, `1157` checks échouent et la p95 monte à `1.67s`. À `200` VUs, la dégradation est confirmée avec une p95 à `5.2s`.

Le taux `http_req_failed` reste à `0.00%`, donc les requêtes reçoivent encore des réponses HTTP. Le problème observé est principalement une dégradation de latence, pas une erreur HTTP.

### Question 4 — Pourquoi l'`api-gateway` reçoit-il environ 2x plus de trafic que le `task-service` et 4x plus que le `user-service` ?

L'`api-gateway` est le point d'entrée unique de l'application. Le script réaliste envoie toutes les requêtes vers `http://localhost:3000`, puis le gateway les relaie vers les services internes.

À chaque itération du scénario réaliste, on a :

- `api-gateway`: 4 requêtes par itération
- `user-service`: 1 requête par itération pour le login
- `task-service`: 2 requêtes par itération pour lister puis créer une tâche
- `notification-service`: 1 requête par itération pour lire les notifications

C'est pour cela que le gateway reçoit environ deux fois plus de trafic que le `task-service`, et environ quatre fois plus que le `user-service`.

### Question 5 — Pourquoi le `task-service` est-il plus impacté que le `user-service` ou le `notification-service` sous forte charge ?

Le `task-service` est plus impacté car il reçoit deux appels par itération et car la création d'une tâche déclenche plus de travail qu'une simple lecture :

- insertion PostgreSQL
- mise à jour des métriques métier
- recalcul du gauge `tasks_gauge`
- publication Redis `task.created`
- création d'un span custom autour de la publication

Le `user-service` ne gère qu'un login par itération, et le `notification-service` fait surtout une lecture des notifications. Le `task-service` combine donc davantage de trafic et davantage d'I/O.

### Question 6 — Que se passe-t-il quand on tente de scaler le `task-service` à 3 replicas ?

Avec la configuration initiale, Docker Compose échoue si `task-service` publie un port hôte fixe :

```yaml
ports:
  - "3002:3002"
```

Chaque replica essaie alors de réserver le port hôte `3002`. Un seul conteneur peut utiliser ce port sur la machine, donc les autres replicas ne peuvent pas démarrer.

Erreur :

```text
Bind for 0.0.0.0:3002 failed: port is already allocated
```

La ligne responsable est la section `ports` du service `task-service` dans `docker-compose.yml`.

Dans l'état actuel du code, cette correction est déjà appliquée : `task-service` utilise `expose: "3002"` au lieu de publier `3002:3002`. La commande suivante démarre donc bien trois replicas :

```bash
docker compose up -d --scale task-service=3
``` 

Résultat: 
```text
dev-projet-task-service-1 Up 3002/tcp
dev-projet-task-service-2 Up 3002/tcp
dev-projet-task-service-3 Up 3002/tcp
```

### Question 7 — Le scaling améliore-t-il les métriques ? Les 3 replicas sont-ils visibles dans Grafana et Prometheus ?

Le scaling peut améliorer partiellement la capacité du `task-service`, car plusieurs conteneurs peuvent traiter le trafic. Mais l'observabilité n'est pas propre avec cette configuration.

Dans Prometheus, on voit toujours une seule target pour `task-service` :

```text
scrapeUrl: http://task-service:3002/metrics
labels: instance="task-service:3002", job="task-service"
health: up
```

Prometheus ne voit donc pas trois targets distinctes. Il scrape seulement le nom DNS Compose `task-service:3002`, qui représente le service, pas chaque replica individuellement.

Dans Grafana, les métriques peuvent donc apparaître sous un seul job `task-service`. On ne peut pas distinguer proprement les trois instances avec la configuration actuelle. Pour surveiller chaque replica séparément, il faudrait une découverte de services ou une configuration Prometheus capable d'exposer chaque instance comme target distincte.

### Question 8 — Pourquoi `docker scale` ne suffit-il pas pour un scaling propre en production ? Qu'apporterait Kubernetes ?

`docker scale` permet de lancer plusieurs conteneurs, mais il ne fournit pas tout ce qui est nécessaire pour une production fiable :

- pas de service discovery robuste par replica
- pas d'observabilité propre par instance
- pas de rolling update complet
- pas d'autoscaling
- pas de rescheduling avancé en cas de panne
- pas de probes de readiness/liveness comparables à Kubernetes

Kubernetes apporte des `Deployments` pour gérer les replicas, des `Services` pour exposer un point d'entrée stable avec load balancing, des probes pour vérifier l'état des pods, du rolling update, du rescheduling automatique et une intégration plus propre avec Prometheus via la découverte de services.

### Question 9 — Le panel *Error Rate 5xx* affiche "No data" alors que k6 signale des erreurs. Le serveur retourne-t-il des erreurs HTTP ?

Dans les résultats k6, `http_req_failed` reste à `0.00%`, même quand `checks_failed` augmente. Cela signifie que les requêtes reçoivent encore une réponse HTTP attendue. Les échecs signalés par k6 viennent surtout du check applicatif `tasks response < 500ms`.

Le panel `Error Rate 5xx` peut donc afficher `No data`, car le serveur ne retourne pas forcément de réponses HTTP 500. Une requête lente mais réussie ne crée pas une erreur 5xx.

Ce panel est utile pour détecter les erreurs HTTP serveur, mais il ne suffit pas pour détecter une dégradation de performance. Pour analyser la charge, il faut aussi regarder :

- `http_req_duration` dans k6
- les checks k6 comme `tasks response < 500ms`
- les logs applicatifs
- les métriques de latence
- éventuellement les métriques système ou reverse-proxy

### Question 10 — Pourquoi le panel *Latency p50/p95/p99* peut-il rester flat alors que k6 mesure une forte p95 ?

Le panel Grafana mesure la latence interne observée par les services Node.js, via la métrique `http_request_duration_ms`. Cette mesure commence quand Express traite la requête et se termine quand la réponse Express est finalisée.

Elle ne mesure pas toute la latence end-to-end vue par k6. Elle ne couvre pas :

- le temps d'attente avant acceptation de la connexion
- la saturation des sockets ou files d'attente côté OS
- les connexions refusées
- les timeouts avant que la requête atteigne Node.js
- la latence côté client
- les limites Docker ou host

k6 mesure la latence depuis le point de vue du client. C'est donc la source de vérité pour l'expérience utilisateur pendant un stress test.

Pour corriger l'écart, il faudrait ajouter une mesure au point d'entrée externe :

- une métrique de latence end-to-end côté API Gateway
- un reverse-proxy comme Nginx, Traefik ou Envoy avec export de métriques
- des métriques système host/container
- des probes synthétiques externes

Grafana montre correctement la latence interne des requêtes traitées. k6 montre la latence réellement ressentie par le client.
