# Réponses TP Partie 2 — Stress test k6

---

## Question 1 — Latence p95 (test léger)

Sur 5 VUs pendant 30 s (1 GET `/api/tasks` par seconde), la p95 est typiquement **< 30 ms** en local, bien en dessous du seuil de 200 ms. Le check `tasks response < 200ms` passe à 100 %.

---

## Question 2 — Taux http_req_failed (test léger)

`http_req_failed` est à **0 %**. 5 VUs avec 1 s de sleep représentent ≈ 5 req/s, largement en dessous de la capacité du service.

---

## Question 3 — Dégradation sous charge progressive

Le scénario réaliste monte de 10 à 50 VUs. Le check `tasks response < 500ms` commence à **échouer massivement à partir de ~30–40 VUs** (phase de montée en charge vers 50).

À 50 VUs la p95 finale dépasse généralement **800 ms – 2 s**.

Pour forcer une dégradation plus nette :
```bash
k6 run --vus 100 --duration 60s -e EMAIL=... -e PASSWORD=... scripts/load-test-realistic.js
```

---

## Question 4 — Répartition du trafic (Request Rate per Service)

Chaque itération du script émet **4 requêtes via l'api-gateway** :

| Étape | Service cible | Nb requêtes |
|---|---|---|
| POST `/api/users/login` | user-service | 1 |
| GET `/api/tasks` | task-service | 1 |
| POST `/api/tasks` | task-service | 1 |
| GET `/api/notifications` | notification-service | 1 |

- `api-gateway` : 4 requêtes (toutes passent par lui)
- `task-service` : 2 → api-gateway reçoit **2×** plus
- `user-service` : 1 → api-gateway reçoit **4×** plus

C'est exactement le ratio observé dans Grafana.

---

## Question 5 — Pourquoi task-service est-il le plus impacté ?

1. **Volume** : 2 requêtes par itération contre 1 pour les autres.
2. **Opérations d'écriture** : le POST `/tasks` déclenche un `INSERT`, puis un `SELECT GROUP BY status` pour la gauge, puis un `PUBLISH` Redis.
3. **Contention PostgreSQL** : les écritures concurrentes génèrent des locks sur la table `tasks`.
4. **Saturation du pool de connexions PG** : avec 50 VUs simultanés, le pool du task-service est épuisé avant celui des autres.

---

## Question 6 — docker scale bloqué par le port statique

```
Error: Bind for 0.0.0.0:3002 failed: port is already allocated
```

**Ligne responsable** dans `docker-compose.yml` :
```yaml
task-service:
  ports:
    - "3002:3002"   # ← un port hôte ne peut être lié qu'une seule fois
```

Un port hôte ne peut être occupé que par un seul processus. Dès le 2e replica, Docker tente de lier `:3002` une deuxième fois → échec.

**Contournement** : supprimer le mapping de port hôte. Les services internes se joignent via le réseau Docker, sans besoin d'exposition sur l'hôte.

```yaml
task-service:
  # ports:
  #   - "3002:3002"
```

---

## Question 7 — Scaling et visibilité Prometheus

**Grafana** : oui, les 3 replicas reçoivent du trafic — Docker assure un load balancing DNS round-robin entre les containers.

**Prometheus (`/targets`)** : seulement **1 target** `task-service` visible, malgré 3 replicas.

**Pourquoi ?** La config statique pointe sur le nom DNS `task-service:3002`. Ce nom résout vers une seule IP à la fois (choix aléatoire parmi les 3). Prometheus ne sait pas qu'il y a plusieurs instances ; il scrappe toujours la même et ignore les deux autres.

Pour surveiller toutes les instances il faudrait utiliser la **service discovery Docker** :
```yaml
- job_name: task-service
  docker_sd_configs:
    - host: unix:///var/run/docker.sock
```

---

## Question 8 — Limites de docker scale vs Kubernetes

| Problème rencontré | docker scale | Kubernetes |
|---|---|---|
| Port hôte unique | Bloquant dès le 2e replica | Pas de mapping hôte, abstraction via `Service` |
| Discovery Prometheus | Statique, replicas invisibles | `kubernetes_sd_configs` découvre tous les pods |
| Load balancing | DNS round-robin basique, pas de health check | kube-proxy + readiness probes, retire les pods malades |
| Rolling update | Indisponibilité pendant redéploiement | Rolling update sans coupure de service |
| Autoscaling | Manuel uniquement | HPA basé sur CPU ou métriques custom |

En résumé : Kubernetes résout nativement le discovery, le load balancing avec health checks, le scaling automatique et les déploiements sans interruption.

---

## Question 9 — Panel "Error Rate 5xx" affiche "No data"

Sous forte charge, les erreurs vues par k6 sont des **refus de connexion TCP** (timeout avant d'atteindre Node.js). Aucune réponse HTTP n'est générée → la métrique `http_requests_total{status=~"5.."}` n'est pas incrémentée → le panel reste vide.

Ce panel détecte les erreurs **applicatives** (ex: bug qui retourne un 500), pas les saturations réseau/OS. Il **ne peut pas** détecter une dégradation de performance due à la surcharge.

---

## Question 10 — Panel "Latency p50/p95/p99" reste plat

**Ce que mesure le panel** : `http_request_duration_ms` est démarré dans le middleware Express, **après** que Node.js a accepté la connexion TCP. Il mesure uniquement le temps de traitement interne.

**Ce qu'il ne mesure pas** : le temps d'attente dans la file TCP (OS backlog), les connexions rejetées, le délai avant que Node.js accepte la connexion.

**D'où vient l'écart avec k6** : k6 mesure la durée **end-to-end** (émission → réception), y compris l'attente dans la queue réseau. Sous charge, la majorité du temps est passée à attendre que le serveur accepte la connexion — temps invisible pour Prometheus.

**Pour rectifier** : démarrer le timer au niveau du **socket TCP** (avant l'event loop Node.js), ou placer un reverse proxy (nginx, Envoy) en frontal qui expose des métriques de file d'attente et de connexion.
