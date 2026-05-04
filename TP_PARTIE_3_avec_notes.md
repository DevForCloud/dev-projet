# TP — Kubernetes 

## Objectif

Déployer l'intégralité de la stack TaskFlow sur un cluster kind local en écrivant les manifests YAML manuellement. L'objectif est de comprendre chaque ressource Kubernetes par la pratique — et de ressentir la répétition qui motive Helm.

---

## Partie 0 

- Docker installé et en cours d'exécution
- `kind` installé — https://kind.sigs.k8s.io/docs/user/quick-start/#installation
- `kubectl` installé — https://kubernetes.io/docs/tasks/tools/
- Les images TaskFlow publiées sur Docker Hub (votre CI doit avoir tourné)

---

## Partie 1 - Monter la stack avec K8S

### Étape 1 — Créer le cluster kind multi-nœuds

Compléter le fichier `k8s/kind-config.yaml` avant de créer le cluster :

```bash
kind create cluster --name taskflow --config k8s/kind-config.yaml
```

```text
Note: J'ai du ajouté `kind: Cluster` dans le kind-config.yaml
```

⚠️ Cette commande peut mettre un certain temps avant d'être complétée.

Vérifiez que le cluster est prêt :

```bash
kubectl get nodes
```

Vous devez voir 3 nœuds en état `Ready`.

Note:
```bash
NAME                     STATUS     ROLES           AGE   VERSION
taskflow-control-plane   NotReady   control-plane   19s   v1.32.2
taskflow-worker          NotReady   <none>          9s    v1.32.2
taskflow-worker2         NotReady   <none>          9s    v1.32.2
```

Créez le namespace staging :

```bash
kubectl create namespace staging
```

---

### Étape 2 — Ouvrir les terminaux d'observation

Avant d'écrire quoi que ce soit, ouvrez 1 terminal et gardez-le visible.

**Terminal A — Watch Pods :**
```bash
watch kubectl get pods -n staging -o wide
```

Aucune donnée pour l'instant. Laissez-le ouvert pendant tout le TP afin de voir l'évolution de votre infrastructure.

---

### Étape 3  — Déployer le user-service

Compléter les fichiers :
- `k8s/base/user-service/configmap.yaml`
    * Compléter la configuration 
    * Ajouter les variables d'environnement
- `k8s/base/user-service/deployment.yaml`
    * Compléter la configuration 
    * Ajouter les spécifications liées à votre image taskflow-user-service (ports, probes, etc.)
- `k8s/base/user-service/service.yaml`
    * Compléter la configuration
    * Ajouter les ports du service

Puis appliquez la configuration :

```bash
kubectl apply -f k8s/base/user-service/
```

> Observez le Terminal A. Les pods passent-ils en 1/1 Running ?

Non il reste en 
```bash
  0/1 ErrImagePull
  0/1 ImagePullBackOff
```
> 
> Si vous voyez `ImagePullBackOff` ou `ErrImagePull`, diagnostiquez avant de continuer, lisez attentivement la section Events. 
> 1. Que vous dit Kubernetes ? 

Dans les Events, Kubernetes dit il essaie de récupérer l’image `dev-projet-user-service:latest` mais il la cherche sur Docker Hub `docker.io/library/dev-projet-user-service:latest`
Et il échoue avec :

  pull access denied, repository does not exist or may require authorization 
  insufficient_scope: authorization failed

Donc Kubernetes ne trouve pas l’image dans son environnement

> 2. Qu'est-ce qui manque dans votre configuration actuelle par rapport à ce que vous avez déployé jusqu'ici ?
 Il manque l’accès à l’image applicative.

Jusqu’ici, avec Docker Compose, l’image `dev-projet-user-service:latest` existe localement, mais le cluster kind est un cluster Kubernetes séparé. Il ne voit pas automatiquement les images locales.

Il faut donc faire publier l’image sur Docker Hub et mettre ce nom dans le manifest :

image: lordtibu/taskflow-user-service:v1.0.0

Ou on peut charger l’image locale dans le cluster kind :

    kind load docker-image dev-projet-user-service:latest --name taskflow
> 
> Corrigez le problème, et vérifiez que les pods passent bien en Running avant de passer à l'étape suivante.

```bash
user-service-77768dcf8b-2fjfw   1/1     Running   0          2m30s   10.244.1.3   taskflow-worker    <none>           <none>
user-service-77768dcf8b-hlz6g   1/1     Running   0          2m10s   10.244.2.3   taskflow-worker2   <none>           <none>
```
---

### Étape 4 — Déployer PostgreSQL (StatefulSet)

Compléter les fichiers suivants : 
 - `k8s/base/postgres/secret.yaml`
 - `k8s/base/postgres/service.yaml`
 - `k8s/base/postgres/statefulset.yaml`

Appliquez :

```bash
kubectl apply -f k8s/base/postgres/
```

> Jetez un œil au **Terminal A** 
> Combien de pods sont en `Running` ?  
Il y a 3 pods en `Running`

```bash 
  postgres-0                      1/1 Running
  user-service-77768dcf8b-2fjfw   1/1 Running
  user-service-77768dcf8b-hlz6g   1/1 Running
```
> Sur quels nœuds sont-ils schedulés ?

Ils sont schedulés sur ces noeuds: 
```bash
  postgres-0                      taskflow-worker2
  user-service-77768dcf8b-2fjfw   taskflow-worker
  user-service-77768dcf8b-hlz6g   taskflow-worker2
```

```text 
1 pod PostgreSQL et 2 pods user-service.
PostgreSQL est schedulé sur taskflow-worker2. Les deux
replicas du user-service sont répartis entre taskflow-
worker et taskflow-worker2.
```

---

> ### Deployment vs StatefulSet
>
> Vous venez de déployer PostgreSQL avec un **StatefulSet**. Vous utiliserez des **Deployments** pour les services applicatifs à partir de l'étape suivante.
>
> Répondez dans votre `REPORT.md` :
>
> 1. Quelle propriété du StatefulSet garantit que chaque Pod conserve toujours le même volume de stockage, même après un redémarrage ou un rescheduling sur un autre nœud ?

```text
La propriété importante est le volumeClaimTemplates du StatefulSet, associé à l’identité stable du pod.

Dans notre cas, le pod PostgreSQL s’appelle toujours postgres-0 et son volume reste associé à ce pod via le PVC créé par le StatefulSet. Même si le pod est supprimé puis recréé, Kubernetes rattache le même volume persistant au même ordinal postgres-0.
```

> 2. Pourquoi un Deployment serait-il inadapté pour PostgreSQL, même si techniquement on peut lui attacher un volume ?

```text
Pour une base de données, ce comportement pose problème :

  - PostgreSQL a besoin d’un stockage persistant stable
  - il ne faut pas que plusieurs pods écrivent n’importe comment dans le même volume
  - l’ordre de création/suppression peut être important
  - l’identité réseau et le volume doivent rester prévisibles
```

> 3. Parmi les services restants de la stack TaskFlow (Redis, notification-service, `api-gateway`, frontend), lequel mériterait potentiellement un StatefulSet plutôt qu'un Deployment en production ? Justifiez votre choix.

```text
Redis est utilisé comme bus Pub/Sub et une perte de données au redémarrage est acceptable, donc un Deployment suffit. Mais en production, si Redis servait aussi à stocker des données importantes, gérer des files persistantes, du cache critique ou une configuration avec réplication, il aurait besoin :
  - d’une identité stable par instance
  - d’un stockage persistant éventuel
  - d’un démarrage ordonné
  - d’une configuration plus contrôlée entre replicas

notification-service, api-gateway et frontend restent plutôt stateless : ils peuvent être répliqués avec des Deployments. Le frontend sert des fichiers statiques, l’api-gateway route les requêtes, et le notification-service peut être relancé sans volume persistant propre dans cette architecture.

```

---

### Étape 5 — Déployer le `task-service` et le `notification-service`

Le `notification-service` s'abonne aux événements Redis publiés par le `task-service`.

Créez les 3 fichiers dans `k8s/base/<nom-du-service>/` en vous basant sur le pattern des étapes précédentes :

- **ConfigMap** (Veillez à inclure toutes les variables d'environnement utiles à chaque service)
- **Deployment**
- **Service** 

> Lisez le fichier `notification-service/src/subscriber.js`.
>
> 1. Comment ce service consomme-t-il les événements Redis ? 

```text
Le notification-service consomme les événements Redis avec le mécanisme Pub/Sub.

Dans notification-service/src/subscriber.js, il crée un client Redis, se connecte à Redis, puis s’abonne à deux channels :

    await subscriber.subscribe('task.created', ...)
    await subscriber.subscribe('task.status_changed', ...)

Quand le task-service publie un événement sur Redis, le notification-service reçoit le message, le parse en JSON, puis crée une notification en mémoire.

```

> 2. Qu'est-ce que cela implique sur le nombre de replicas à choisir ? Pour quel(s) service(s) ?

```text
Cela implique de garder le notification-service à 1 replica dans cette version.

Le task-service, lui, peut avoir plusieurs replicas, car il est stateless : il écrit en base PostgreSQL et publie dans Redis.

Donc le choix fait est :
    task-service: 2 replicas
    notification-service: 1 replica
```

> 3. Justifiez votre choix dans votre `REPORT.md`.

```text
Le notification-service stocke les notifications dans un tableau en mémoire. Si on lance plusieurs replicas, chaque pod aura son propre état local.

En plus, avec Redis Pub/Sub, plusieurs abonnés peuvent recevoir les mêmes événements. Plusieurs replicas du notification-service risqueraient donc de créer des notifications dupliquées ou incohérentes selon le pod qui répond à la requête. 
C’est pour cela que le notification-service reste à 1 replica. Le task-service peut être répliqué, car il ne garde pas d’état local important : les tâches sont stockées dans PostgreSQL et les événements sont publiés dans Redis.
```

Appliquez et vérifiez que les Pods passent en `1/1 Running`.

---

### Étape 6 — Déployer Redis (Deployment)

Redis est utilisé comme bus de messages entre le `task-service` et le `notification-service`. Contrairement à PostgreSQL, une perte des données Redis au redémarrage est acceptable en environnement de développement.

Compléter les fichiers suivants :
- `k8s/base/redis/deployment.yaml`
    * Compléter la configuration
    * ℹ️ Contrairement aux services HTTP, Redis n'expose pas d'endpoint `/health`. Adaptez la `readinessProbe` pour vérifier qu'il est prêt à accepter des connexions.
- `k8s/base/redis/service.yaml`
    * Compléter la configuration
    * Ajouter les ports

Appliquez :

```bash
kubectl apply -f k8s/base/redis/
```

---

### Étape 7 — Déployer l'`api-gateway` et le frontend

L'`api-gateway` est le point d'entrée unique pour les clients. Il reçoit les requêtes et les proxie vers les services internes.

Le frontend est une application React compilée et servie par nginx. L'image embarque une configuration nginx qui proxie les requêtes `/api` vers l'`api-gateway` — ce nom DNS est résolu automatiquement grâce au Service Kubernetes de l'`api-gateway`.

Comme à l'étape 5, créez les fichiers de configuration dans des dossiers dédiés.

> Pour chaque service, posez-vous ces questions : 
>
> 1. Que sert-il ? De la logique métier ou des fichiers statiques ?

```text
api-gateway sert de point d’entrée HTTP. Il exécute du code applicatif : vérification JWT, routage et proxy vers user-service, task-service et notification-service. 
frontend sert des fichiers statiques React compilés via nginx : HTML, CSS et JavaScript. Il ne contient pas de logique métier côté serveur.
```

> 2. Y a-t-il un état partagé entre les requêtes qui pourrait poser problème avec plusieurs instances ?

```text
Non, api-gateway est stateless : il vérifie les tokens JWT et relaie les requêtes, mais ne stocke pas d’état local important entre deux requêtes.
Et le frontend il sert uniquement des fichiers statiques. Plusieurs replicas peuvent servir les mêmes fichiers sans conflit.
```

> 3. Quel est l'impact d'une indisponibilité momentanée de l'un d'entre eux en environnement staging ?

```text
Si api-gateway est indisponible, l’application devient pratiquement inutilisable côté client, car toutes les routes /api passent par lui.

Si frontend est indisponible, l’interface web n’est plus accessible, mais les services backend peuvent encore fonctionner et être testés directement.

En staging, l’impact est gênant mais pas critique comme en production.
```

> 4. Exécute-t-il du code à chaque requête, ou se contente-t-il de servir des fichiers précompilés ? Qu'est-ce que cela implique sur les ressources nécessaires (requests et limits) ?

```text
api-gateway exécute du code à chaque requête : middleware d’authentification, logs, métriques et proxy HTTP. Il a donc besoin de ressources un peu plus élevées :

  requests:
    memory: 128Mi
    cpu: 100m
  limits:
    memory: 256Mi
    cpu: 300m

frontend sert des fichiers précompilés avec nginx. Il consomme moins de CPU et de mémoire, donc des ressources plus faibles suffisent :

  requests:
    memory: 32Mi
    cpu: 25m
  limits:
    memory: 96Mi
    cpu: 100m
```

> Choisissez le nombre de replicas et dimensionnez les ressources pour chaque service. Justifiez vos choix dans `REPORT.md`.

```text
api-gateway: 2 replicas
frontend: 2 replicas

Les deux sont stateless, donc faciles à répliquer. api-gateway est critique car toutes les requêtes API passent par lui. Le frontend est aussi répliqué pour éviter qu’un seul pod rende l’interface indisponible.
```

Appliquez et vérifiez que les Pods passent en `1/1 Running`.

---

### Étape 8 — Vérifier que tout tourne

```bash
kubectl get all -n staging
```

Tous les Pods doivent être en `1/1 Running`. Si un Pod reste en `0/1` ou `CrashLoopBackOff` :

```bash
kubectl describe pod -l app=<nom-du-pod> -n staging
kubectl logs pod -l app=<nom-du-pod> -n staging
```

Vérifiez les logs des services principaux :

```bash
kubectl logs -n staging deployment/task-service
kubectl logs -n staging deployment/user-service
kubectl logs -n staging deployment/notification-service
kubectl logs -n staging deployment/api-gateway
```

> **Note :** vous pouvez voir des erreurs de connexion vers `otel-collector` dans les logs. C'est normal — le collecteur OpenTelemetry fait partie de la stack d'observabilité (voir `docker-compose.infra.yaml`) qui n'est pas déployée dans ce TP. Ces erreurs sont sans impact sur le fonctionnement applicatif.

---

## Partie 2 — Exposer avec un Ingress

Activez l'addon Ingress de kind :

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
```

Attendez que l'Ingress controller soit prêt :

```bash
kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller \
  --timeout=90s
```

⚠️ Le manifest kind de l'Ingress controller ne force pas le scheduling sur le control-plane par défaut. Il peut atterrir sur n'importe quel worker, où le port 80 n'est pas exposé vers votre machine. 

Le controller **doit** tourner sur `taskflow-control-plane`. Effectuez une vérification explicite sur la colonne NODE avant de continuer :

```bash
kubectl get pods -n ingress-nginx -o wide
```

Pour corriger ça, on ajoute `ingress-ready: "true"` au `nodeSelector` du controller.

```bash
kubectl patch deployment ingress-nginx-controller -n ingress-nginx \
  --type='json' \
  -p='[{"op":"add","path":"/spec/template/spec/nodeSelector/ingress-ready","value":"true"}]'
```

On vient d'effectuer une opération de patch sur le manifest de Deployment du `ingress-nginx-controller` :

`op: add` — on ajoute une clé
`path` — le chemin dans le manifest à modifier
`value: "true"` — la valeur du label à matcher

Seul le control-plane porte ce label (configuré dans `kind-config.yaml`), donc le pod sera forcé de s'y scheduler.

Ensuite, on attend que le rollout soit terminé avant de continuer. Sans ça vous appliquerez l'Ingress avant que le controller soit prêt :

```bash
kubectl rollout status deployment/ingress-nginx-controller -n ingress-nginx
```

On vérifie maintenant que le controller tourne bien sur `taskflow-control-plane` :

```bash
kubectl get pods -n ingress-nginx -o wide
```

Complétez la configuration `k8s/base/ingress.yaml` en configurant les routes de votre application. 

Appliquez et testez :

```bash
kubectl apply -f k8s/base/ingress.yaml
curl http://localhost/api/health
```

Ouvrez http://localhost dans votre navigateur — vous devez voir l'interface TaskFlow.

> 1. Essayez de créer un compte sur l'interface. Est-ce que ça fonctionne ?

```text
Oui, la création de compte fonctionne depuis l’Ingress. La requête passe par la chaîne :

  Ingress -> api-gateway -> user-service -> PostgreSQL

Le user-service répond bien avec un utilisateur créé en base.
```

> 2. Si vous obtenez une erreur, remontez la chaîne de logs (Ingress → api-gateway → user-service ...) jusqu'au service concerné. Une fois la cause identifiée, vous aurez besoin d'inspecter directement le contenu de la base. Comment accéder à PostgreSQL depuis votre machine ? 

```text
Si on devait accéder à PostgreSQL depuis la machine, on utiliserait un port-forward :

  kubectl port-forward -n staging svc/postgres 5432:5432

Puis, dans un autre terminal :

  psql postgresql://taskflow:taskflow@localhost:5432/taskflow

On peut aussi entrer directement dans le pod :

  kubectl exec -it -n staging postgres-0 -- psql -U taskflow -d taskflow
```

> 3. Comparez votre configuration Kubernetes avec docker-compose.yaml. Qu'est-ce qui est fait dans Compose et qui n'existe pas encore dans vos manifests ?

```text
Dans docker-compose.yml, PostgreSQL monte directement le script d’initialisation :

  ./scripts/init.sql:/docker-entrypoint-initdb.d/init.sql

Dans Kubernetes, ce montage n’existait pas au départ. Il a fallu le reproduire avec une ConfigMap montée dans /docker-entrypoint-initdb.d.

Aussi Docker Compose expose directement des ports sur lamachine hôte, alors que Kubernetes utilise des services internes et un Ingress pour exposer l’application 
Compose utilise aussi env_file: .env, alors que Kubernetes sépare la configuration entre ConfigMap et Secret.
```

> Rectifiez le problème et commentez votre investigation dans `REPORT.md`

---

> ### Service vs Ingress
>
> Vous avez maintenant des **Services** (ClusterIP) et un **Ingress** dans votre cluster. Ces deux ressources exposent du trafic, mais à des niveaux et avec des responsabilités différentes.
>
> Répondez dans votre `REPORT.md` :
>
> 1. Vous avez utilisé une commande pour vous connecter à PostgreSQL depuis votre machine. Pourquoi n'avez-vous pas pu vous connecter directement sur `localhost:5432` sans celle-ci ?

```text
Parce que PostgreSQL est exposé avec un Service Kubernetes interne de type ClusterIP.

Un ClusterIP rend le service accessible à l’intérieur du cluster, par exemple depuis les autres pods avec :

  postgres:5432

Mais il ne publie pas le port 5432 sur la machine hôte. Donc depuis ta machine, localhost:5432 ne pointe pas vers PostgreSQL Kubernetes.

Pour y accéder depuis la machine, il faut créer un tunnel avec :

  kubectl port-forward -n staging svc/postgres 5432:5432

Cette commande relie temporairement ton localhost:5432 au service PostgreSQL dans le cluster.
```
> 2. Quel composant du cluster fait réellement le routage HTTP que vous avez décrit dans votre `Ingress` ? Comment est-il apparu dans le cluster ?

```text
Le routage HTTP est fait par le contrôleur ingress-nginx, plus précisément par le pod :
    ingress-nginx-controller

L’objet Ingress ne route pas lui-même le trafic. Il décrit seulement les règles :

  /api -> api-gateway
  / -> frontend

Le composant qui lit ces règles et configure le routage réel est l’Ingress Controller.

Il est apparu dans le cluster après l’application du manifest officiel kind :

  kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml

Ensuite, on a vérifié qu’il tournait bien sur :

  taskflow-control-plane
```

> 3. Dans votre cluster, qui joue le rôle de load balancer entre les replicas de `task-service` ? Est-ce l'Ingress, le Service, ou autre chose ? Qu'est-ce que cela implique sur le rôle réel de l'Ingress dans cette architecture ?

```text
L’Ingress route le trafic HTTP externe vers api-gateway. Ensuite, l’api-gateway appelle :

  http://task-service:3002

Ce nom DNS pointe vers le Service Kubernetes task-service. Ce Service sélectionne les pods avec :

  selector:
    app: task-service

Puis Kubernetes répartit le trafic vers les endpoints disponibles,
c’est-à-dire les replicas du task-service.

Donc dans cette architecture :

  Ingress -> api-gateway Service -> api-gateway Pods -> task-service
  Service -> task-service Pods

L’Ingress sert surtout de point d’entrée HTTP depuis l’extérieur du cluster. Le load balancing interne entre replicas est assuré par les Services Kubernetes.
```

---

## Partie 3 — Scénarios d'observation (live)

Ces scénarios se font en gardant le Terminal A ouvert.

### Scénario 1 — Self-healing

```bash
kubectl delete pod -n staging -l app=task-service
```

Observez le Terminal A. 

> Décrivez dans votre `REPORT.md` ce que vous voyez et pourquoi Kubernetes recrée les Pods.

```text
Avant la suppression, le Deployment task-service avait 2 replicas disponibles :

  task-service-59b6b6774c-8p4x8   1/1 Running
  task-service-59b6b6774c-dm8cq   1/1 Running

Après la commande :

  kubectl delete pod -n staging -l app=task-service

les deux pods ont été supprimés. Kubernetes a immédiatement recréé deux nouveaux pods :

  task-service-59b6b6774c-hmb8x   0/1 Running
  task-service-59b6b6774c-js52x   0/1 Running

Quelques secondes plus tard, ils sont passés en Ready :

  task-service-59b6b6774c-hmb8x   1/1 Running
  task-service-59b6b6774c-js52x   1/1 Running

Kubernetes recrée les pods parce que task-service est géré par un Deployment avec replicas: 2. Le Deployment délègue à un ReplicaSet la responsabilité de maintenir en permanence deux pods correspondant au selector app=task-service.

Quand on supprime manuellement les pods, l’état réel du cluster ne correspond plus à l’état désiré. Le contrôleur Kubernetes détecte qu’il manque deux replicas et crée automatiquement de nouveaux pods pour revenir à l’état attendu. C’est le mécanisme de self-healing.
```

### Scénario 2 — Readiness probe

Recréez le cluster from scratch avec la readiness probe du `task-service` délibérément cassée. Modifiez le path dans `k8s/base/task-service/deployment.yaml` avant d'appliquer :

```yaml
readinessProbe:
  httpGet:
    path: /does-not-exist
    port: 3002
```

```bash
kind delete cluster --name taskflow
kind create cluster --name taskflow --config k8s/kind-config.yaml
kubectl create namespace staging
kubectl apply -f k8s/base/ --recursive
```

> Observez la colonne READY du Terminal A. 
> 1. Dans quel état sont les pods du `task-service` ?

```text
Les pods du task-service sont en Running, mais pas Ready.

Le conteneur tourne, mais Kubernetes ne le considère pas prêt à recevoir du trafic, car la readiness probe appelle :

  /does-not-exist

Cette route n’existe pas, donc elle retourne une erreur.
```

> 2. Essayez de vous connecter, puis de créer une tâche. Quels services répondent, lesquels ne répondent pas ? 

Le frontend répond encore, car nginx sert les fichiers statiques (il a fallut installé a nouveau le controller Ingress): 

L’api-gateway répond aussi, par exemple :

curl http://localhost/api/health

Le user-service répond aussi : on peut créer un compte ou te connecter, car il dépend surtout de PostgreSQL.

En revanche, la création de tâche ne fonctionne pas. Le task-service n’est pas considéré comme Ready, donc il est retiré des endpoints du Service Kubernetes task-service.

Résultat attendu côté application :

frontend: répond
api-gateway: répond
user-service: répond
postgres: répond
task-service: ne reçoit pas de trafic via le Service
création de tâche: échoue

Remettez le path à `/health`, réappliquez et observez les pods repasser en 1/1.

> 3. Réessayez de créer une tâche.

```text
Après ça, la création de tâche refonctionne, car le Service Kubernetes task-service retrouve des endpoints prêts.
```

> Documentez dans votre `REPORT.md` puis expliquez la différence entre une readiness probe et une liveness probe. Que se serait-il passé si vous aviez cassé la liveness probe à la place ? 

```text
La readinessProbe indique si un pod est prêt à recevoir du trafic. Si elle échoue, le pod continue de tourner, mais Kubernetes le retire des endpoints du Service. Il n’est donc plus utilisé pour répondre aux requêtes.

La livenessProbe indique si le conteneur est encore vivant. Si elle échoue, Kubernetes considère que le conteneur est bloqué ou cassé, puis le redémarre.

Si on avait cassé la livenessProbe au lieu de la readinessProbe, les pods du task-service auraient été redémarrés en boucle. On aurait probablement vu des RESTARTS augmenter, voire un état instable de type redémarrages répétés.
```


### Scénario 3 — Rolling update

**1. Préparez une v1.0.1 identifiable du frontend**

Faites une modification visible dans l'interface (couleur, texte, titre...), buildez et publiez l'image :

```bash
docker build -t <votre-dockerhub>/taskflow-frontend:v1.0.1 ./frontend
docker push <votre-dockerhub>/taskflow-frontend:v1.0.1
```

**2. Déclenchez le rolling update** — modifiez le tag dans `k8s/base/frontend/deployment.yaml` (`v1.0.0` → `v1.0.1`) puis appliquez :

```bash
kubectl apply -f k8s/base/frontend/deployment.yaml
```

Observez la cohabitation des pods dans le Terminal A. Rafraîchissez http://localhost — la nouvelle version est en ligne.

**3. Consultez l'historique** :

```bash
kubectl rollout history -n staging deployment/frontend
```

Que voyez-vous dans la colonne `CHANGE-CAUSE` ? Est-ce utile ?

Annotez les révisions pour les rendre lisibles :

```bash
kubectl annotate deployment/frontend -n staging kubernetes.io/change-cause="passage à v1.0.1 - nouvelle interface"
```

**4. Faites un rollback** :

```bash
kubectl rollout undo deployment/frontend -n staging
```

Vérifiez dans le navigateur que l'ancienne version est restaurée. Consultez à nouveau l'historique.

---

> 1. Pendant le rolling update, le nombre de pods disponibles a-t-il diminué ? Pourquoi ?
> 2. Que se serait-il passé si le nouveau pod n'était jamais passé en `1/1` ?
> 3. Pourquoi annoter les révisions est-il important en équipe ?
> 4. `kubectl rollout undo` est-il suffisant comme stratégie de rollback en production ? Quelles limites voyez-vous ?

---

> ### Réflexion théorique
>
> Vous venez d'écrire environ 20 fichiers YAML pour déployer cette stack en staging.
>
> Répondez dans votre `REPORT.md` :
>
> 1. Identifiez au moins 3 valeurs que vous avez répétées dans plusieurs fichiers (namespace, nom d'image, URL de service...). Que se passe-t-il concrètement si vous devez changer l'une d'elles pour un déploiement en production ?

---

## Livrable

- Dossier `k8s/base/` avec tous les manifests versionnés : postgres, redis, user-service, task-service, notification-service, api-gateway, frontend, ingress
- L'interface TaskFlow accessible et fonctionnelle sur http://localhost
- `REPORT.md` avec :
  - Réponses aux questions théoriques et justification de vos choix
  - Observations et analyses des scénarios d'observation (self-healing, readiness probe, rolling update)
