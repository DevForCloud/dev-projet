# TP — Stress test avec k6

## Objectif

Observer le comportement de TaskFlow sous charge et identifier le goulot d'étranglement en combinant les résultats k6 (latence end-to-end) et Grafana (trafic par service en temps réel).

---

## Prérequis

- TaskFlow lancé avec sa stack d'observabilité depuis la commande `npm run dev:infra`
- Grafana accessible sur http://localhost:3100 dans ce projet (`3100:3000` dans `docker-compose.infra.yml`)
- Le panel **Request Rate per Service** — doit montrer le trafic reçu par chaque service en req/s
- k6 installé — [https://k6.io/docs/get-started/installation/](https://k6.io/docs/get-started/installation/)
- Un token JWT valide (se connecter via le frontend et récupérer le token dans le localStorage ou les DevTools)
- Un compte utilisateur valide dans l'application (email + mot de passe)

> **Note** : le panel *Latency p50/p95/p99* mesure le temps de traitement **interne** au service (une fois la connexion TCP acceptée par Node.js). Sous forte charge, les connexions refusées au niveau OS ne sont jamais chronométrées. Utilisez le **résumé terminal de k6** comme source de vérité pour la latence end-to-end.

---

## Étape 1 — Lancer un premier test léger

Regardez le ficher `scripts/load-test-light.js`, lancer le test de charge légère.

```bash
k6 run -e TOKEN=<votre_token> scripts/load-test-light.js
```
### Question 1 — Quelle est la latence p95 affichée par k6 pendant ce test léger ? Est-elle dans les seuils acceptables (< 200ms) ?

La latence p95 doit etre lue dans le resume terminal k6, ligne `http_req_duration`.

Resultat observe:

```text
http_req_duration: avg=20.14ms min=6.8ms med=16.84ms max=44.6ms p(90)=38.9ms p(95)=42.05ms
```

Interpretation: la p95 vaut `42.05ms`, donc le test leger reste largement sous le seuil acceptable de `200ms`.

### Question 2 - Le taux `http_req_failed` est-il à 0 % ? Si non, quel code d'erreur observez-vous ?

Le taux `http_req_failed` doit etre lu dans le resume terminal k6.

Resultat observe:

```text
http_req_failed: 0.00% 0 out of 150
checks_failed: 0.00% 0 out of 300
```

Interpretation: aucune requete HTTP n'a echoue et tous les checks sont passes. Aucun code d'erreur n'a ete observe pendant le test leger.

## Étape 2 — Monter la charge progressivement

Lancez maintenant le script réaliste `scripts/load-test-realistic.js` qui simule un vrai parcours utilisateur sur tous les services :

```bash
k6 run -e EMAIL=<email> -e PASSWORD=<password> scripts/load-test-realistic.js
k6 run -e HIGH_VUS=100 -e EMAIL=<email> -e PASSWORD=<password> scripts/load-test-realistic.js
k6 run -e HIGH_VUS=200 -e EMAIL=<email> -e PASSWORD=<password> scripts/load-test-realistic.js
```

Relancez et observez **Grafana** + **terminal k6** en continu.


### Question 3 - Dans le résumé k6, observez les lignes `checks_failed` et `http_req_duration`. À partir de quel stade (combien de VUs) le check `tasks response < 500ms` commence-t-il à échouer massivement ? Quelle est la p95 finale ?

Dans le resume k6, il faut regarder:

- `checks_failed`
- `http_req_duration`
- le check nomme `tasks response < 500ms`

Resultat observe:

```text
HIGH_VUS=50:
checks_failed: 0.00% 0 out of 12528
tasks response < 500ms: 100% de succes
http_req_duration p(95)=73.52ms
http_req_failed: 0.00% 0 out of 8352

HIGH_VUS=100:
checks_failed: 7.32% 1157 out of 15804
tasks response < 500ms: 56% de succes, 1477 succes / 1157 echecs
http_req_duration p(95)=1.67s
http_req_failed: 0.00% 0 out of 10536

HIGH_VUS=200:
checks_failed: 13.03% 1712 out of 13134
tasks response < 500ms: 21% de succes, 477 succes / 1712 echecs
http_req_duration p(95)=5.2s
http_req_failed: 0.00% 0 out of 8756
```

Interpretation: le check `tasks response < 500ms` commence a echouer massivement a partir de `HIGH_VUS=100`. A `50` VUs, tous les checks passent encore. A `100` VUs, `1157` checks echouent et la p95 finale monte a `1.67s`. A `200` VUs, la degradation est confirmee avec une p95 a `5.2s` et seulement `21%` de succes pour le check `tasks response < 500ms`. Le taux `http_req_failed` reste pourtant a `0.00%`, ce qui montre que le serveur repond encore en HTTP, mais trop lentement pour respecter le seuil applicatif.

### Question 4 - Dans Grafana, observez le panel **Request Rate per Service** au pic de charge. L'`api-gateway` reçoit environ 2× plus de trafic que le `task-service` et 4× plus que le `user-service`. Expliquez pourquoi en vous appuyant sur le script de test : combien de requêtes par service sont émises à chaque itération ?

Au pic de charge, `api-gateway` recoit plus de trafic car il est le point d'entree unique. Chaque iteration du scenario realiste fait 4 appels HTTP vers `api-gateway`.

Repartition par service applicatif:

- `api-gateway`: 4 requetes par iteration
- `user-service`: 1 requete par iteration, pour le login
- `task-service`: 2 requetes par iteration, pour lister puis creer une tache
- `notification-service`: 1 requete par iteration, pour lire les notifications

C'est pour cela que `api-gateway` recoit environ 2 fois plus de trafic que `task-service`, et environ 4 fois plus que `user-service`.

### Question 5 - Pourquoi le `task-service` est-il plus impacté que le `user-service` ou le `notification-service` sous forte charge ?

Le `task-service` est plus impacte parce qu'il recoit deux appels par iteration et parce que son endpoint de creation fait plus de travail qu'une simple lecture:

- insertion PostgreSQL
- mise a jour des metriques metier
- recalcul du gauge `tasks_gauge`
- publication Redis `task.created`
- generation d'une trace avec span custom autour de la publication

Le `user-service` ne gere qu'un login par iteration, et le `notification-service` ne fait qu'une lecture en memoire dans cette implementation. Le `task-service` combine donc plus de trafic et plus d'I/O.

## Étape 3 — Tester les limites de `docker scale`

**Manipulation 1** — Tentez de scaler le `task-service` à 3 replicas :

```bash
docker compose up --scale task-service=3
```

### Question 6 - Que se passe-t-il ? Quelle erreur obtenez-vous et pourquoi ? Identifiez dans le `docker-compose.yml` la ligne responsable.

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

Dans l'etat actuel du repository, cette correction est deja appliquee: `task-service` utilise `expose: "3002"` au lieu de publier `3002:3002`. Le scaling observe avec la commande suivante a donc demarre correctement les trois replicas:

```bash
docker compose up -d --scale task-service=3
```

Resultat observe:

```text
dev-projet-task-service-1 Up 3002/tcp
dev-projet-task-service-2 Up 3002/tcp
dev-projet-task-service-3 Up 3002/tcp
```

**Manipulation 2** — Contourner cette erreur en modifiant `docker-compose.yml`, puis relancez :

```bash
docker compose up --scale task-service=3
```

Relancez ensuite le test k6 et observez Grafana.

### Question 7 - Le scaling a-t-il amélioré les métriques ? Dans Grafana, les 3 replicas reçoivent-ils du trafic ? Mêmes questions depuis l'interface Prometheus sur http://localhost:9090/targets. Combien de targets `task-service` voyez-vous malgré les 3 replicas ? Expliquez pourquoi Prometheus ne peut pas surveiller les 3 instances individuellement avec cette configuration ?

Le scaling peut ameliorer partiellement la capacite du `task-service`, mais il ne rend pas l'architecture propre pour autant.

Dans Grafana, le trafic peut continuer a apparaitre sous un seul job `task-service`, car les metriques Prometheus sont scrapees via la cible statique `task-service:3002`.

Dans Prometheus sur http://localhost:9090/targets, on voit toujours une seule target pour le job `task-service`:

```text
task-service:3002
```

Observation apres scaling:

```text
scrapeUrl: http://task-service:3002/metrics
labels: instance="task-service:3002", job="task-service"
health: up
```

Prometheus ne voit donc pas 3 targets distinctes. La configuration actuelle ne connait pas les noms ou adresses individuelles des replicas. Elle ne fait qu'interroger le nom DNS Compose du service.

Pour monitorer chaque replica individuellement, il faudrait une decouverte de services qui expose chaque instance comme target separee, ou une configuration generee dynamiquement.

### Question 8 - Pourquoi `docker scale` ne suffit pas pour un scaling propre en production ? Qu'est-ce qu'un orchestrateur comme Kubernetes apporterait pour résoudre les problèmes que vous avez rencontrés ?

`docker scale` ne suffit pas pour un scaling propre en production parce qu'il ne fournit pas tout ce qui est necessaire autour du simple demarrage de plusieurs conteneurs:

- pas de service discovery robuste pour l'observabilite par replica
- pas de load balancing applicatif explicite et controle
- pas de rolling update propre
- pas d'autoscaling
- pas de rescheduling automatique avance en cas de panne
- pas de configuration native des probes de readiness/liveness comparable a Kubernetes

Kubernetes apporte des `Deployments` pour gerer les replicas, des `Services` pour exposer un point d'entree stable avec load balancing, des probes, du rolling update, du service discovery, et une integration beaucoup plus propre avec Prometheus via des mecanismes de decouverte.

## Étape 4 — Limites de l'instrumentation

### Question 9 - Le panel *Error Rate 5xx* affiche "No data" alors que k6 signale des erreurs. Le serveur retourne-t-il des erreurs HTTP ? Peut-on utiliser ce panel pour détecter une dégradation de performance ?

Le panel `Error Rate 5xx` peut afficher `No data` alors que k6 signale des erreurs, car k6 ne compte pas seulement les reponses HTTP 5xx.

k6 peut signaler des erreurs pour:

- connexion refusee
- timeout
- reset TCP
- requete interrompue avant reception d'une reponse HTTP
- echec d'un check applicatif, par exemple `tasks response < 500ms`

Dans ces cas, le serveur n'a pas forcement retourne de reponse HTTP 500. Si la requete n'atteint pas Express, la metrique applicative `http_requests_total{status=~"5.."}` n'est jamais incrementee.

Conclusion: ce panel est utile pour detecter les erreurs HTTP 5xx retournees par les services, mais il ne suffit pas pour detecter une degradation de performance ou des erreurs reseau/end-to-end sous forte charge.

Pour detecter une degradation de performance, il faut aussi regarder:

- le resume k6, surtout `http_req_failed`, `http_req_duration` et les checks
- les erreurs de connexion ou timeouts dans k6
- les logs applicatifs et Docker
- les metriques systeme ou reverse-proxy si disponibles

### Question 10 - Le panel *Latency p50/p95/p99* reste flat pendant tout le test, alors que k6 mesure une p95 qui ne correcpond pas à ce que montre Grafana. D'où vient cet écart ? Qu'est-ce que ce panel mesure réellement, et qu'est-ce qu'il ne mesure pas ? Que faudrait-il faire pour rectifier ça ?

Le panel `Latency p50/p95/p99` de Grafana reste flat parce qu'il mesure la latence interne observee par les services Node.js, via `http_request_duration_ms`.

Cette metrique commence quand Express traite la requete et se termine quand la reponse Express est finalisee. Elle ne mesure pas toute la latence end-to-end vue par k6.

Elle ne mesure pas:

- le temps d'attente avant acceptation de la connexion
- la saturation du socket ou de la file d'attente OS
- les connexions refusees
- les timeouts avant que la requete atteigne Node.js
- la latence reseau cote client
- les echecs ou delais au niveau Docker / host

k6 mesure la latence end-to-end depuis le client de test. C'est donc la source de verite pour l'experience utilisateur pendant le stress test.

Pour rectifier ce decalage, il faudrait ajouter une instrumentation au point d'entree externe:

- mesurer la latence cote API Gateway avec une metrique dediee end-to-end
- ajouter un reverse-proxy comme Nginx/Traefik/Envoy et exporter ses metriques
- collecter des metriques systeme host/container
- ajouter des blackbox probes ou synthetic checks depuis l'exterieur
- conserver k6 comme mesure de reference pour les tests de charge

Grafana montre correctement la latence interne des services qui ont effectivement traite une requete. k6 montre la latence et les echecs ressentis par le client.
