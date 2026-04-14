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
