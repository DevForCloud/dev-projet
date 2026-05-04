#### Traces

##### Compréhension

Réalisez le scénario suivant et documentez ce que vous observez :

- Faire une requête POST `/api/tasks` depuis le frontend
- Retrouver la trace dans Grafana > Explore > Tempo
- Identifier la chaîne de spans (api-gateway → task-service → postgres)
- Commenter, expliquer les attributs (http.method, http.route, db.statement, etc ...)

---

##### Réponse

### Chaîne de spans observée

```
POST /api/tasks  (api-gateway)
  └── POST /tasks  (task-service)
        ├── pg.query INSERT INTO tasks ...  (postgres)
        └── pg.query SELECT status, COUNT(*) ...  (postgres)
```

Tous ces spans partagent le même `traceId` grâce au header `traceparent` propagé automatiquement par l'auto-instrumentation OpenTelemetry.

### Attributs principaux

- `http.method` / `http.route` / `http.status_code` — décrivent la requête HTTP à chaque service
- `service.name` — identifie le service (`api-gateway`, `task-service`), déclaré dans `tracing.js`
- `db.system = "postgresql"` — type de BDD
- `db.statement` — la requête SQL exacte (ex: `INSERT INTO tasks ... RETURNING *`), instrumentée automatiquement via le driver `pg`
- `net.peer.name` — hôte cible du span sortant

---

##### Ajout de spans custom

L'auto-instrumentation couvre déjà HTTP et PostgreSQL. Redis/pub-sub n'est pas toujours auto-instrumenté.

Dans `task-service/src/routes.js`, span manuel ajouté autour de la publication Redis :

```js
const { trace } = require('@opentelemetry/api');
const tracer = trace.getTracer('task-service');

const span = tracer.startSpan('publish.task.created');
await publish("task.created", { ... });
span.end();
```

Le span `publish.task.created` apparaît dans la vue distribuée de la trace dans Grafana > Explore > Tempo, rattaché au même `traceId`. Il est créé manuellement car le client Redis/pub-sub n'est pas couvert par l'auto-instrumentation.

---

### C. Logs — Visualisation

#### Filtrer les logs du task-service dans Loki

Requête LogQL :
```logql
{container="/task-service"}
```

**Différence avec Prometheus :**
- Prometheus : requête sur des **métriques** (séries numériques agrégées), ex: `http_requests_total{job="task-service"}`
- Loki : requête sur des **flux de logs bruts** (texte/JSON), filtrés par labels puis par contenu. Pas d'agrégation par défaut.

---

#### Log d'erreur suite à une tâche sans title

Requête pour filtrer les erreurs du task-service :
```logql
{container="/task-service"} | json | level="error"
```

---

#### Logs level=error sur tous les services

```logql
{job="containers"} | json | level="error"
```

Filtrer sur statusCode=500 via les logs JSON Pino :
```logql
{job="containers"} | json | statusCode=`500`
```

**Comparaison avec Prometheus :**
- Prometheus : `http_requests_total{status="500"}` → compteur pré-agrégé, très performant pour les alertes et dashboards
- Loki : scan des logs bruts à la volée, plus lent mais donne le **contexte complet** (message, payload)

**Laquelle choisir ?** Prometheus pour détecter et alerter sur les volumes d'erreurs. Loki pour investiguer le détail d'une erreur spécifique.

---

#### traceId dans Loki

Pino ne propage pas automatiquement le `traceId` OpenTelemetry dans les logs.

Pour retrouver manuellement un traceId dans Loki :
```logql
{job="containers"} |= "abc123traceId"
```

**Pour que ce soit automatique**, il faudrait injecter le `traceId` courant dans chaque log via l'API OpenTelemetry :
```js
const { trace } = require('@opentelemetry/api');
const span = trace.getActiveSpan();
logger.info({ traceId: span?.spanContext().traceId }, 'message');
```

Grafana pourrait alors lier automatiquement logs ↔ traces via le champ `tracesToLogsV2` de la datasource Tempo.

---

#### Démarche d'investigation lors d'un pic d'erreurs

1. **Prometheus** — identifier le service et la route en cause : `http_requests_total{status="500"}`, depuis quand ?
2. **Loki** — sur la plage horaire du pic, lire les logs d'erreur du service :
   ```logql
   {container="/api-gateway"} | json | level="error"
   ```
3. **Tempo** — si un `traceId` apparaît dans les logs, l'ouvrir dans Tempo pour voir la trace distribuée et identifier le span en échec.

> Métriques → détectent et quantifient. Logs → expliquent ce qui s'est passé. Traces → montrent où exactement dans la chaîne.
