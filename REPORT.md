# REPORT — TaskFlow

Nicolas PATINO - Jean Paul LALANDE

Ce rapport regroupe les réponses aux questions des TP

## Partie 1 — Observabilité

### Traces — Création d'une tâche

Après avoir créé une tâche depuis le frontend, la trace a été retrouvée dans Grafana > Explore > Tempo en filtrant sur le service `api-gateway` et la route `POST /api/tasks`.

La chaîne de spans observée est :

```text
api-gateway -> task-service -> PostgreSQL
```

`api-gateway` reçoit la requête HTTP `POST /api/tasks`, puis relaie la requête vers `task-service`. Le `task-service` traite la création de tâche et exécute ensuite une requête SQL `INSERT INTO tasks (...)`.

Les attributs importants observés sont :

- `resource.service.name` : service qui produit le span, par exemple `api-gateway` ou `task-service`
- `http.method` : méthode HTTP utilisée, ici `POST`
- `http.route` : route traitée, par exemple `/api/tasks` ou `/tasks`
- `http.status_code` : statut HTTP retourné, par exemple `201`
- `db.system` : système de base de données, ici `postgresql`
- `db.name` : base utilisée, ici `taskflow`
- `db.statement` : requête SQL exécutée
- `net.peer.name` et `net.peer.port` : destination réseau, ici `postgres:5432`

Les spans HTTP montrent la propagation de la requête entre les services. Le span PostgreSQL montre l'accès réel à la base de données.

### Spans custom Redis

L'auto-instrumentation couvre déjà HTTP et PostgreSQL, mais Redis Pub/Sub n'est pas toujours couvert automatiquement. Un span manuel autour de la publication Redis permet de visualiser dans Tempo l'étape où le `task-service` publie l'événement `task.created`.

Cela rend la trace plus complète :

```text
api-gateway -> task-service -> PostgreSQL -> Redis publish
```

### Logs — Syntaxe LogQL utilisée

Pour filtrer les logs du `task-service` dans Loki, la requête utilisée est :

```logql
{service="task-service"}
```

### Différence avec une requête Prometheus

Prometheus interroge des métriques numériques avec PromQL :

```promql
http_requests_total{status="500"}
```

Loki interroge des logs avec LogQL :

```logql
{service="task-service"} |= "request failed"
```

Prometheus est plus adapté pour mesurer, agréger et alerter. Loki est plus adapté pour lire les événements détaillés, les messages d'erreur et les informations de contexte.

### Filtrer une erreur volontaire dans Loki

Pour déclencher une erreur :

```bash
curl -X POST http://localhost:3002/tasks \
  -H "Content-Type: application/json" \
  -d '{}'
```

Pour filtrer les requêtes en erreur `400` :

```logql
{service="task-service"} | json statusCode="res.statusCode" | statusCode = `400`
```

Pour filtrer les logs contenant un échec :

```logql
{service="task-service"} |= "request failed"
```

### Logs de niveau error sur tous les services

```logql
{service=~"api-gateway|user-service|task-service|notification-service", level="error"}
```

### Équivalent Loki des erreurs HTTP 500

Avec Prometheus :

```promql
http_requests_total{status="500"}
```

Avec Loki :

```logql
{service=~"api-gateway|user-service|task-service|notification-service"} | json statusCode="res.statusCode" | statusCode = `500`
```

Prometheus est plus adapté pour détecter et alerter sur un pic d'erreurs. Loki est plus adapté pour investiguer le détail des erreurs.

### TraceId dans Loki

Trace observée :

```json
{
  "trace_id": "a22fec1964b10a76a73998c3e61b664b"
}
```

On peut retrouver ce traceId dans Loki si les logs contiennent le champ `trace_id` :

```logql
{service="task-service"} |= "a22fec1964b10a76a73998c3e61b664b"
```

Pour que ce lien soit automatique, il faut configurer les `derived fields` dans la datasource Loki de Grafana afin de transformer le champ `trace_id` en lien vers Tempo.

### Démarche d'investigation avec métriques, logs et traces

1. Identifier le service en erreur dans Prometheus :

```promql
sum by (job) (rate(http_requests_total{status=~"5.."}[5m]))
```

2. Aller dans Loki et filtrer les logs du service concerné :

```logql
{service="task-service", level="error"}
```

3. Extraire ou copier le `trace_id` depuis les logs.

4. Rechercher la trace correspondante dans Tempo.

5. Lire la trace pour identifier où l'erreur apparaît : `api-gateway`, `task-service`, PostgreSQL, Redis, etc.

## Partie 2 — Stress test avec k6

### Question 1 — Quelle est la latence p95 pendant le test léger ?

Résultat observé :

```text
http_req_duration: avg=20.14ms min=6.8ms med=16.84ms max=44.6ms p(90)=38.9ms p(95)=42.05ms
```

La latence p95 est de `42.05ms`. Elle est largement inférieure au seuil demandé de `200ms`, donc le test léger est acceptable.

### Question 2 — Le taux `http_req_failed` est-il à 0 % ?

Résultat observé :

```text
http_req_failed: 0.00% 0 out of 150
checks_failed: 0.00% 0 out of 300
```

Le taux `http_req_failed` est bien à `0.00%`. Aucun code d'erreur HTTP n'a été observé pendant le test léger.

### Question 3 — À partir de quel stade le check `tasks response < 500ms` échoue-t-il massivement ?

Résultats observés :

```text
HIGH_VUS=50:
checks_failed: 0.00%
http_req_duration p(95)=73.52ms

HIGH_VUS=100:
checks_failed: 7.32%
tasks response < 500ms: 56% de succès
http_req_duration p(95)=1.67s

HIGH_VUS=200:
checks_failed: 13.03%
tasks response < 500ms: 21% de succès
http_req_duration p(95)=5.2s
```

Le check commence à échouer massivement à partir de `HIGH_VUS=100`. À `50` VUs, tous les checks passent encore. À `100` VUs, la p95 monte à `1.67s`. À `200` VUs, la p95 atteint `5.2s`.

Le taux `http_req_failed` reste à `0.00%`, donc le problème est une dégradation de latence, pas une erreur HTTP.

### Question 4 — Pourquoi l'api-gateway reçoit-il plus de trafic ?

L'`api-gateway` est le point d'entrée unique de l'application. Le script réaliste envoie toutes les requêtes vers le gateway, puis celui-ci relaie vers les services internes.

À chaque itération :

- `api-gateway` reçoit 4 requêtes
- `user-service` reçoit 1 requête pour le login
- `task-service` reçoit 2 requêtes pour lister puis créer une tâche
- `notification-service` reçoit 1 requête pour lire les notifications

C'est pour cela que le gateway reçoit environ deux fois plus de trafic que le `task-service`, et environ quatre fois plus que le `user-service`.

### Question 5 — Pourquoi le task-service est-il plus impacté ?

Le `task-service` est plus impacté car il reçoit deux appels par itération et car la création d'une tâche déclenche plus de travail :

- insertion PostgreSQL
- mise à jour des métriques métier
- recalcul du gauge `tasks_gauge`
- publication Redis `task.created`
- création d'un span custom autour de la publication

Le `user-service` ne gère qu'un login par itération. Le `notification-service` fait surtout une lecture des notifications. Le `task-service` combine donc davantage de trafic et davantage d'I/O.

### Question 6 — Que se passe-t-il quand on scale task-service à 3 replicas ?

Avec la configuration initiale, Docker Compose échoue si `task-service` publie un port hôte fixe :

```yaml
ports:
  - "3002:3002"
```

Chaque replica essaie de réserver le port hôte `3002`. Un seul conteneur peut utiliser ce port sur la machine, donc les autres replicas ne peuvent pas démarrer.

Erreur :

```text
Bind for 0.0.0.0:3002 failed: port is already allocated
```

La correction consiste à utiliser `expose: "3002"` au lieu de publier `3002:3002`. Dans l'état actuel, cette correction est appliquée et la commande peut démarrer trois replicas :

```bash
docker compose up -d --scale task-service=3
```

### Question 7 — Le scaling améliore-t-il les métriques ? Les 3 replicas sont-ils visibles ?

Le scaling peut améliorer partiellement la capacité du `task-service`, car plusieurs conteneurs peuvent traiter le trafic. Mais l'observabilité n'est pas propre avec cette configuration.

Dans Prometheus, on voit toujours une seule target pour `task-service` :

```text
scrapeUrl: http://task-service:3002/metrics
labels: instance="task-service:3002", job="task-service"
```

Prometheus scrape le nom DNS Compose `task-service:3002`, qui représente le service, pas chaque replica individuellement. On ne peut donc pas distinguer correctement les trois instances avec la configuration actuelle.

### Question 8 — Pourquoi `docker scale` ne suffit-il pas en production ?

`docker scale` lance plusieurs conteneurs, mais ne fournit pas tout ce qui est nécessaire pour une production fiable :

- pas de service discovery robuste par replica
- pas d'observabilité propre par instance
- pas de rolling update complet
- pas d'autoscaling
- pas de rescheduling avancé en cas de panne
- pas de probes de readiness/liveness comparables à Kubernetes

Kubernetes apporte des Deployments pour gérer les replicas, des Services pour exposer un point d'entrée stable avec load balancing, des probes, du rolling update, du rescheduling automatique et une meilleure intégration avec Prometheus.

### Question 9 — Le panel Error Rate 5xx affiche "No data" alors que k6 signale des erreurs. Le serveur retourne-t-il des erreurs HTTP ?

Dans les résultats k6, `http_req_failed` reste à `0.00%`, même quand `checks_failed` augmente. Cela signifie que les requêtes reçoivent encore une réponse HTTP.

Les échecs signalés par k6 viennent surtout du check applicatif `tasks response < 500ms`. Le panel `Error Rate 5xx` peut donc afficher `No data`, car le serveur ne retourne pas de réponses HTTP 500.

Ce panel est utile pour détecter les erreurs serveur, mais il ne suffit pas pour détecter une dégradation de performance.

### Question 10 — Pourquoi le panel Latency p50/p95/p99 reste flat alors que k6 mesure une forte p95 ?

Le panel Grafana mesure la latence interne observée par les services Node.js, via la métrique `http_request_duration_ms`. Cette mesure commence quand Express traite la requête et se termine quand la réponse Express est finalisée.

Elle ne mesure pas toute la latence end-to-end vue par k6 :

- temps d'attente avant acceptation de la connexion
- saturation des sockets ou files d'attente côté OS
- connexions refusées
- timeouts avant que la requête atteigne Node.js
- latence côté client
- limites Docker ou host

k6 mesure la latence depuis le point de vue du client. C'est donc la source de vérité pour l'expérience utilisateur pendant un stress test.

Pour corriger l'écart, il faudrait ajouter une mesure au point d'entrée externe : API Gateway, reverse-proxy avec métriques, métriques système, ou probes synthétiques.

## Partie 3 — Kubernetes

### Étape 3 — ImagePullBackOff du user-service

#### Les pods passent-ils en `1/1 Running` ?

Au début non. Le pod reste en :

```text
0/1 ErrImagePull
0/1 ImagePullBackOff
```

#### 1. Que dit Kubernetes ?

Kubernetes essaie de récupérer l'image `dev-projet-user-service:latest`, mais il la cherche sur Docker Hub sous le nom :

```text
docker.io/library/dev-projet-user-service:latest
```

Il échoue avec :

```text
pull access denied, repository does not exist or may require authorization
insufficient_scope: authorization failed
```

Kubernetes ne trouve donc pas l'image dans son environnement.

#### 2. Qu'est-ce qui manque dans la configuration actuelle ?

Il manque une image accessible par le cluster Kubernetes.

Avec Docker Compose, l'image locale existe sur la machine. Le cluster kind est séparé et ne voit pas automatiquement cette image locale.

Il faut publier l'image sur Docker Hub :

```yaml
image: lordtibu/taskflow-user-service:v1.0.0
```

ou charger l'image locale dans kind :

```bash
kind load docker-image dev-projet-user-service:latest --name taskflow
```

### Étape 4 — PostgreSQL

#### Combien de pods sont en `Running` ?

Après le déploiement de PostgreSQL, trois pods sont en `Running` :

```text
postgres-0
user-service replica 1
user-service replica 2
```

#### Sur quels noeuds sont-ils schedulés ?

Les pods sont répartis sur les workers. Exemple observé :

```text
postgres-0                      taskflow-worker2
user-service-...                taskflow-worker
user-service-...                taskflow-worker2
```

### Deployment vs StatefulSet

#### 1. Quelle propriété garantit que chaque Pod conserve le même volume ?

La propriété importante est `volumeClaimTemplates`, associée à l'identité stable du pod.

Le pod PostgreSQL s'appelle toujours `postgres-0`. Son PVC reste lié à cet ordinal. Même si le pod est recréé, Kubernetes rattache le même volume persistant au même pod logique.

#### 2. Pourquoi un Deployment serait-il inadapté pour PostgreSQL ?

Un Deployment est adapté aux applications stateless. Pour PostgreSQL, il faut une identité stable et un stockage persistant stable.

Un Deployment pourrait créer ou remplacer des pods de manière interchangeable, ce qui est risqué pour une base de données. Plusieurs pods ne doivent pas écrire n'importe comment dans le même volume, et l'identité réseau doit rester prévisible.

#### 3. Quel service restant mériterait potentiellement un StatefulSet ?

Redis pourrait mériter un StatefulSet en production si on l'utilisait pour stocker des données importantes, gérer des files persistantes ou fonctionner en réplication.

Dans ce TP, Redis sert seulement de bus Pub/Sub et la perte des messages au redémarrage est acceptable, donc un Deployment suffit.

`notification-service`, `api-gateway` et `frontend` restent plutôt stateless.

### Étape 5 — task-service et notification-service

#### 1. Comment le notification-service consomme-t-il les événements Redis ?

Le `notification-service` utilise Redis Pub/Sub.

Il crée un client Redis, se connecte à Redis, puis s'abonne aux channels :

```text
task.created
task.status_changed
```

Quand le `task-service` publie un événement, le `notification-service` reçoit le message, le parse en JSON et crée une notification en mémoire.

#### 2. Qu'est-ce que cela implique sur le nombre de replicas ?

Le `notification-service` doit rester à `1` replica dans cette version.

Le `task-service` peut avoir plusieurs replicas, car il est stateless : les tâches sont stockées dans PostgreSQL et les événements sont publiés dans Redis.

#### 3. Justification du choix

Le `notification-service` stocke les notifications en mémoire. Si on lance plusieurs replicas, chaque pod aura son propre état local.

Avec Redis Pub/Sub, plusieurs abonnés peuvent aussi recevoir les mêmes événements. Plusieurs replicas pourraient donc créer des notifications dupliquées ou incohérentes.

Choix retenu :

```text
task-service: 2 replicas
notification-service: 1 replica
```

### Étape 7 — api-gateway et frontend

#### 1. Que sert chaque service ?

`api-gateway` sert de point d'entrée HTTP et exécute du code applicatif : vérification JWT, routage et proxy vers les services internes.

`frontend` sert des fichiers statiques React compilés via nginx.

#### 2. Y a-t-il un état partagé problématique ?

Non. `api-gateway` est stateless et le `frontend` sert uniquement des fichiers statiques. Plusieurs replicas peuvent donc fonctionner sans conflit.

#### 3. Impact d'une indisponibilité en staging

Si `api-gateway` est indisponible, les routes `/api` ne fonctionnent plus et l'application devient pratiquement inutilisable côté client.

Si `frontend` est indisponible, l'interface web n'est plus accessible, mais les backends peuvent encore être testés directement.

En staging, l'impact est gênant mais moins critique qu'en production.

#### 4. Code exécuté ou fichiers précompilés ? Impact ressources ?

`api-gateway` exécute du code à chaque requête. Il a donc besoin de ressources plus élevées :

```yaml
requests:
  memory: 128Mi
  cpu: 100m
limits:
  memory: 256Mi
  cpu: 300m
```

`frontend` sert des fichiers précompilés avec nginx. Il consomme moins de ressources :

```yaml
requests:
  memory: 32Mi
  cpu: 25m
limits:
  memory: 96Mi
  cpu: 100m
```

Choix retenu :

```text
api-gateway: 2 replicas
frontend: 2 replicas
```

Les deux sont stateless. `api-gateway` est critique car toutes les requêtes API passent par lui. Le frontend est répliqué pour éviter qu'un seul pod rende l'interface indisponible.

### Partie 2 Kubernetes — Ingress

#### 1. Créer un compte depuis l'interface fonctionne-t-il ?

Oui. La requête passe par :

```text
Ingress -> api-gateway -> user-service -> PostgreSQL
```

Le `user-service` répond correctement et l'utilisateur est créé en base.

#### 2. Comment accéder à PostgreSQL depuis la machine ?

Avec un port-forward :

```bash
kubectl port-forward -n staging svc/postgres 5432:5432
```

Puis :

```bash
psql postgresql://taskflow:taskflow@localhost:5432/taskflow
```

On peut aussi entrer directement dans le pod :

```bash
kubectl exec -it -n staging postgres-0 -- psql -U taskflow -d taskflow
```

#### 3. Qu'est-ce qui existe dans Compose mais pas encore dans les manifests ?

Dans `docker-compose.yml`, PostgreSQL monte directement le script d'initialisation :

```yaml
./scripts/init.sql:/docker-entrypoint-initdb.d/init.sql
```

Dans Kubernetes, il a fallu reproduire ce montage avec une ConfigMap montée dans `/docker-entrypoint-initdb.d`.

Compose expose aussi des ports directement sur la machine hôte, alors que Kubernetes utilise des Services internes et un Ingress. Compose utilise `env_file: .env`, alors que Kubernetes sépare ConfigMap et Secret.

### Service vs Ingress

#### 1. Pourquoi ne pas se connecter directement à `localhost:5432` ?

PostgreSQL est exposé avec un Service interne de type `ClusterIP`.

Le service est accessible à l'intérieur du cluster via :

```text
postgres:5432
```

Mais il ne publie pas `5432` sur la machine hôte. Il faut donc utiliser `kubectl port-forward`.

#### 2. Quel composant fait réellement le routage HTTP ?

Le routage HTTP est fait par le contrôleur `ingress-nginx`, via le pod `ingress-nginx-controller`.

L'objet Ingress ne route pas lui-même le trafic : il décrit les règles. Le controller lit ces règles et configure le routage réel.

Il est apparu dans le cluster après l'application du manifest officiel :

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
```

#### 3. Qui load balance entre les replicas de task-service ?

Le load balancing interne entre les replicas de `task-service` est assuré par le Service Kubernetes `task-service`, pas par l'Ingress.

L'Ingress sert de point d'entrée HTTP externe. Ensuite, les Services Kubernetes répartissent le trafic vers les pods prêts.

### Scénario 1 — Self-healing

Après la commande :

```bash
kubectl delete pod -n staging -l app=task-service
```

les pods `task-service` sont supprimés, puis Kubernetes en recrée automatiquement deux nouveaux.

C'est normal car `task-service` est géré par un Deployment avec `replicas: 2`. Le ReplicaSet maintient l'état désiré. Si l'état réel ne correspond plus, Kubernetes recrée les pods manquants.

### Scénario 2 — Readiness probe

#### 1. Dans quel état sont les pods du task-service ?

Avec la readiness probe cassée sur `/does-not-exist`, les pods sont en `Running`, mais pas `Ready`. La colonne READY reste à `0/1`.

Le conteneur tourne, mais Kubernetes ne le considère pas prêt à recevoir du trafic.

#### 2. Quels services répondent ?

Le `frontend` répond, car nginx sert les fichiers statiques.

`api-gateway` répond aussi sur `/api/health`.

`user-service` répond, donc la connexion ou la création de compte fonctionne.

La création de tâche échoue, car `task-service` n'est pas Ready et il est retiré des endpoints du Service Kubernetes.

#### 3. Après correction sur `/health`, que se passe-t-il ?

Les pods du `task-service` repassent en `1/1 Running`. Le Service Kubernetes retrouve des endpoints prêts et la création de tâche refonctionne.

#### Différence entre readiness probe et liveness probe

La `readinessProbe` indique si un pod est prêt à recevoir du trafic. Si elle échoue, le pod continue de tourner mais il est retiré des endpoints du Service.

La `livenessProbe` indique si le conteneur est vivant. Si elle échoue, Kubernetes redémarre le conteneur.

Si la liveness probe avait été cassée, les pods auraient été redémarrés en boucle et le compteur `RESTARTS` aurait augmenté.

### Scénario 3 — Rolling update

#### Que voit-on dans `CHANGE-CAUSE` avant annotation ?

Avant annotation :

```text
REVISION  CHANGE-CAUSE
1         <none>
2         <none>
```

Ce n'est pas utile, car on ne sait pas ce qui a changé entre les révisions.

Après annotation :

```text
REVISION  CHANGE-CAUSE
2         passage à v1.0.1 - nouvelle interface
```

L'historique devient exploitable.

#### 1. Pendant le rolling update, le nombre de pods disponibles a-t-il diminué ?

Non. Kubernetes garde les anciens pods actifs pendant que les nouveaux démarrent. Le Service ne route le trafic que vers les pods Ready.

#### 2. Que se serait-il passé si le nouveau pod n'était jamais passé en `1/1` ?

Le rollout serait resté bloqué. Le nouveau pod n'aurait pas reçu de trafic, car il n'aurait pas été ajouté aux endpoints du Service. Les anciens pods auraient continué à servir l'application.

#### 3. Pourquoi annoter les révisions est-il important en équipe ?

Sans annotation, `CHANGE-CAUSE` affiche `<none>`. En équipe, annoter permet de savoir quelle version a été déployée, pourquoi, et quelle révision choisir en cas de rollback.

#### 4. `kubectl rollout undo` est-il suffisant en production ?

Non. `kubectl rollout undo` ne rollback que le Deployment. Il ne gère pas les migrations de base de données, les secrets, les changements de configuration, les dépendances frontend/backend ni la validation métier.

En production, il faut une stratégie plus complète : CI/CD, manifests versionnés, monitoring, health checks, migrations compatibles, rollback testé, et éventuellement canary ou blue/green deployment.

### Réflexion théorique — valeurs répétées dans les YAML

Valeurs répétées :

- namespace `staging`
- images Docker comme `lordtibu/taskflow-frontend:v1.0.0`
- URLs internes comme `http://user-service:3001`, `http://task-service:3002`, `redis://redis:6379`
- ports `3000`, `3001`, `3002`, `3003`, `6379`, `5432`
- noms de Services Kubernetes comme `user-service`, `task-service`, `redis`, `postgres`

Si on doit changer une de ces valeurs pour la production, il faut modifier plusieurs fichiers YAML manuellement. Cela augmente le risque d'oublier un fichier, de garder une ancienne URL, de déployer une mauvaise image ou de créer une configuration incohérente.

C'est pour cela qu'en production on utilise souvent Kustomize ou Helm pour centraliser les valeurs variables selon l'environnement.

## Partie 4A — Helm

### Réflexion théorique — Helm et répétition

#### 1. Comment Helm résout-il le problème de répétition ? Quel fichier joue le rôle central ?

Helm résout le problème de répétition en transformant les manifests Kubernetes en templates réutilisables.

Au lieu de répéter partout le namespace, les images, les tags, les ports, les replicas, les URLs internes ou les ressources, on centralise ces valeurs dans un fichier de valeurs. Les templates les réutilisent ensuite avec la syntaxe Helm :

```yaml
image: "{{ .Values.image.prefix }}-task-service:{{ .Values.taskService.tag }}"
replicas: {{ .Values.taskService.replicaCount }}
```

Le fichier central pour ce problème est `values.yaml`. Il contient les valeurs configurables du déploiement. `Chart.yaml` reste important, mais il décrit surtout le chart : nom, version, description et dépendances.

#### 2. À partir de quel niveau de complexité Helm devient-il indispensable ?

Helm devient indispensable dès qu'on dépasse un petit déploiement statique.

Dans TaskFlow, on a déjà plusieurs services : `user-service`, `task-service`, `notification-service`, `api-gateway`, `frontend`, PostgreSQL, Redis et Ingress. On a aussi beaucoup de valeurs répétées : images, tags, ports, replicas, URLs, ressources et namespace.

Avec un seul environnement, Helm est déjà utile. Il devient vraiment indispensable dès qu'on a plusieurs environnements, par exemple `staging` et `production`, car il faut changer proprement les tags d'images, les ressources, les replicas, les secrets, les noms de domaine Ingress ou les paramètres de base de données.

Sans Helm, il faut dupliquer ou modifier beaucoup de YAML à la main. Avec Helm, on garde les mêmes templates et on change seulement les fichiers de valeurs ou les surcharges passées à la commande.

### Étape 1 — Chart TaskFlow, Redis et PostgreSQL

#### 1. Pourquoi Redis se prête-t-il à un chart officiel ?

Redis se prête à un chart officiel parce que c'est un composant d'infrastructure générique et standard. Sa configuration n'est pas spécifique à TaskFlow : port `6379`, Service Kubernetes, probes, ressources, authentification, persistance éventuelle, réplication ou mode standalone.

Ces besoins sont communs à beaucoup de projets. Il est donc préférable d'utiliser un chart maintenu par la communauté, comme Bitnami Redis, plutôt que de maintenir nous-mêmes un template Redis maison.

Dans notre chart, le Service Redis généré par Bitnami s'appelle `redis-master`, donc les services applicatifs utilisent :

```yaml
REDIS_URL: redis://redis-master:6379
```

#### 2. Pourquoi conserver un template maison pour PostgreSQL plutôt que `bitnami/postgresql` ?

On a conservé un template maison pour PostgreSQL parce que notre configuration est spécifique au projet et au TP.

Deux éléments rendraient la migration vers `bitnami/postgresql` coûteuse :

- le script d'initialisation SQL custom, monté dans `/docker-entrypoint-initdb.d`, qui crée les tables `users`, `tasks`, `notifications` et insère des données de départ
- le Secret maison et les variables associées `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, utilisées pour construire les `DATABASE_URL` des services applicatifs

Avec Bitnami, il faudrait adapter les noms de Secrets, les clés, le mécanisme d'initialisation et les chaînes de connexion attendues par les services.

### Étape 2 — Values par environnement et secrets

#### Problème des valeurs sensibles dans `values.production.yaml`

Un fichier `values.production.yaml` est versionné dans Git. Il ne doit donc pas contenir de vrais secrets : mot de passe PostgreSQL, token JWT, clé API, secret Docker, etc.

Même dans un dépôt privé, un secret versionné est considéré comme compromis. Il peut être lu par toutes les personnes ayant accès au dépôt, rester dans l'historique Git, être copié dans un fork, apparaître dans des logs CI/CD ou être exposé par erreur.

La stratégie retenue est de garder `values.yaml` et `values.production.yaml` versionnés, mais uniquement avec des placeholders non sensibles :

```yaml
postgres:
  password: REMPLACER_PAR_MOT_DE_PASSE_FORT

apiGateway:
  jwtSecret: REMPLACER_PAR_SECRET_JWT_FORT
```

Il ne faut pas supprimer `values.yaml` du dépôt : un chart Helm doit rester compréhensible et fournir une structure de configuration par défaut. Les vraies valeurs sont injectées au moment du déploiement.

#### 1. Comment déployer avec des valeurs sensibles sans les commiter ?

On injecte les secrets au moment du déploiement avec des variables d'environnement ou un gestionnaire de secrets.

Exemple local :

```bash
export POSTGRES_PASSWORD='mot-de-passe-fort'
export JWT_SECRET='secret-jwt-fort'
```

Puis :

```bash
helm upgrade --install taskflow ./helm/taskflow \
  -n production \
  -f helm/taskflow/values.production.yaml \
  --set-string postgres.password="$POSTGRES_PASSWORD" \
  --set-string apiGateway.jwtSecret="$JWT_SECRET"
```

On peut aussi créer les Secrets Kubernetes séparément et faire référencer ces Secrets par le chart.

#### 2. Pourquoi est-ce plus sûr que de mettre les valeurs dans un dépôt privé ?

Cette solution est plus sûre parce que les secrets ne sont pas stockés dans Git.

Un dépôt privé reste accessible à plusieurs personnes, peut être cloné, utilisé par la CI, forké ou exposé par erreur. Surtout, un secret commité reste dans l'historique Git même après suppression du fichier.

Avec des variables d'environnement ou un secret manager, les valeurs sensibles ne sont fournies qu'au moment du déploiement. Elles ne sont pas présentes dans le dépôt ni dans son historique.

#### 3. Quel problème résout `helm-secrets` que cette solution ne résout pas ?

Notre solution évite de commiter les secrets en clair, mais elle ne permet pas de versionner proprement les valeurs sensibles.

`helm-secrets` permet de commiter un fichier de valeurs chiffré, par exemple `secrets.production.yaml`, puis de le déchiffrer à la volée au moment du `helm upgrade`.

Il devient nécessaire dans un contexte GitOps ou CI/CD avancé, quand plusieurs personnes ou environnements doivent partager les mêmes secrets de manière contrôlée, quand on veut historiser leurs changements, ou quand le déploiement doit être entièrement reproductible depuis Git sans exposer les secrets en clair.

#### 4. Comment passer `$POSTGRES_PASSWORD` dans GitHub Actions sans l'afficher en clair ?

On stocke la valeur dans GitHub Actions Secrets, puis on l'injecte comme variable d'environnement dans le step de déploiement :

```yaml
- name: Deploy with Helm
  env:
    POSTGRES_PASSWORD: ${{ secrets.POSTGRES_PASSWORD }}
    JWT_SECRET: ${{ secrets.JWT_SECRET }}
  run: |
    helm upgrade --install taskflow ./helm/taskflow \
      -n production \
      -f helm/taskflow/values.production.yaml \
      --set-string postgres.password="$POSTGRES_PASSWORD" \
      --set-string apiGateway.jwtSecret="$JWT_SECRET"
```

GitHub masque automatiquement les valeurs issues de `secrets.*` dans les logs. Il faut éviter de faire `echo $POSTGRES_PASSWORD` ou d'activer un mode debug qui afficherait les commandes avec leurs valeurs expansées.

### Étape 3 — Installation du chart

#### 1. Que se passe-t-il si une variable référencée dans un template n'a pas de valeur ?

Si une valeur référencée est absente, Helm peut échouer au rendu ou produire un YAML invalide.

Test effectué :

```bash
helm template taskflow ./helm/taskflow \
  --namespace staging \
  --values ./helm/taskflow/values.yaml \
  --show-only templates/task-service.yaml \
  --set-json taskService=null
```

Résultat :

```text
Error: template: taskflow/templates/task-service.yaml:20:22:
executing "taskflow/templates/task-service.yaml" at <.Values.taskService.replicaCount>:
nil pointer evaluating interface {}.replicaCount
```

Ici Helm échoue parce que le template essaie d'accéder à `.Values.taskService.replicaCount` alors que `taskService` n'existe plus.

Pour éviter ce type de problème, on vérifie le rendu avec `helm template` et `helm lint`, et on peut utiliser `default` quand une valeur de secours est pertinente.

#### 2. Différences entre `helm template` du task-service et `k8s/base/task-service/deployment.yaml`

Le fichier manuel `k8s/base/task-service/deployment.yaml` contient seulement le `Deployment`.

Le rendu Helm de `templates/task-service.yaml` génère trois objets :

```text
ConfigMap
Service
Deployment
```

Différences observées :

- Helm ajoute des commentaires de source, par exemple `# Source: taskflow/templates/task-service.yaml`
- les variables sont remplacées par les valeurs finales : image, replicas, `REDIS_URL`, ressources
- dans `k8s/base`, les ressources sont séparées en fichiers `configmap.yaml`, `service.yaml`, `deployment.yaml`
- l'ordre de certaines clés peut changer, par exemple `limits` avant `requests`

Ces différences existent parce que Helm stocke des templates paramétrables et génère le YAML final à partir de `values.yaml`. Le but est d'éviter la duplication et de pouvoir changer les valeurs selon l'environnement.

### Étape 4 — Mise à jour avec helm-diff

#### 1. Commande de prévisualisation et sortie

Plugin utilisé : `helm-diff`.

Installation :

```bash
helm plugin install https://github.com/databus23/helm-diff
```

Modification effectuée dans `helm/taskflow/values.yaml` :

```diff
notificationService:
-  replicaCount: 1
+  replicaCount: 2
  tag: v1.0.0
```

Commande de prévisualisation :

```bash
helm diff upgrade taskflow ./helm/taskflow \
  -n staging \
  --values ./helm/taskflow/values.yaml
```

Sortie importante :

```diff
staging, notification-service, Deployment (apps) has changed:
  spec:
-   replicas: 1
+   replicas: 2
```

Cette sortie montre que le prochain `helm upgrade` va modifier le Deployment `notification-service` en passant de `1` à `2` replicas.

#### 2. Dans quel scénario helm-diff est-il particulièrement critique ?

`helm-diff` est particulièrement critique lors d'un changement de `image.<service>.tag`.

Un changement de `replicaCount` modifie surtout le nombre de pods. Kubernetes ajoute ou retire des replicas, et le Service n'envoie du trafic qu'aux pods Ready.

Un changement de tag d'image déclenche un rolling update. Kubernetes crée des pods avec la nouvelle image, attend qu'ils soient Ready, puis remplace progressivement les anciens. Si la nouvelle image contient un bug mais passe quand même la readiness probe, Kubernetes peut remplacer une version saine par une version cassée.

`helm-diff` permet donc de vérifier avant l'upgrade quelle image va changer, sur quel service et avec quel tag exact. C'est plus critique qu'un simple changement de `replicaCount`.

### Réflexion théorique — Historique des déploiements

#### 1. Qu'avez-vous vu avec `watch kubectl get pods -n staging -o wide` ?

Pendant les upgrades, Kubernetes fait évoluer les pods progressivement.

Lors d'un changement de replicas, un nouveau pod apparaît en `0/1 ContainerCreating`, puis passe en `1/1 Running`. Avec `-o wide`, on voit aussi sur quel noeud chaque pod est schedulé, par exemple `taskflow-worker` ou `taskflow-worker2`.

Lors d'un rolling update, les anciens pods et les nouveaux pods peuvent cohabiter temporairement. Kubernetes garde les anciens pods disponibles tant que les nouveaux ne sont pas prêts.

#### 2. Quelle information présente dans `helm history` est absente de `kubectl rollout history` ?

`helm history` donne une vision au niveau de la release Helm complète. Il affiche le numéro de révision Helm, la date, le statut, le chart, l'app version et la description de l'action : install, upgrade ou rollback.

`kubectl rollout history` est limité à un Deployment précis. Il ne sait pas quelle release Helm complète a été installée ou mise à jour.

Cette information est critique en production, car une application ne se résume pas à un Deployment. Une release peut modifier en même temps des Deployments, Services, ConfigMaps, Secrets, Ingress et sous-charts comme Redis. Avec `helm history`, on sait quelle révision globale de l'application a été déployée.

#### 3. Différence entre `helm rollback taskflow 1` et `kubectl rollout undo deployment/task-service`

`kubectl rollout undo deployment/task-service` rollback uniquement le Deployment `task-service`.

Il ne rollback pas les autres ressources associées : ConfigMap, Secret, Service, Ingress, autres Deployments ou dépendances Helm comme Redis.

`helm rollback taskflow 1` rollback toute la release Helm `taskflow` vers la révision 1. Il restaure l'ensemble des ressources gérées par Helm dans un état cohérent.

La différence fondamentale est donc le périmètre :

```text
kubectl rollout undo = rollback d'un seul Deployment
helm rollback = rollback de toute la release applicative
```

En production, Helm est plus adapté pour revenir à une version cohérente de l'application complète.
