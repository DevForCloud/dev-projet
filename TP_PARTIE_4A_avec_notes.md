# TP — Helm

## Objectif

Packager l'ensemble de TaskFlow dans un chart Helm.

---

## Prérequis

- Helm installé — https://helm.sh/docs/intro/install/
- Le cluster kind `taskflow` toujours actif

> ### Réflexion théorique
>
> Répondez dans votre `REPORT.md` :
>
> 1. Comment Helm résout-il le problème de répétition vu dans la dernière partie du TP (cf. dernière question théorique de la partie précédente) ? Quel fichier joue le rôle central dans un chart Helm ?

```text
Helm résout le problème de répétition en transformant les manifests Kubernetes en templates réutilisables.
Au lieu de répéter partout des valeurs on les centralise dans un fichier de valeurs, puis les templates les réutilisent avec la syntaxe Helm :

  image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
  replicas: {{ .Values.replicaCount }}

Le fichier central d’un chart Helm est principalement values.yaml

C’est lui qui contient les valeurs configurables du déploiement. Les manifests dans templates/ utilisent ces valeurs pour générer les YAML Kubernetes finaux.

Chart.yaml est aussi important, mais il sert surtout à décrire le chart : nom, version, description, dépendances. Pour résoudre la répétition et adapter le déploiement selon
l’environnement, le fichier central est values.yaml.
```

> 2. À partir de quel niveau de complexité (nombre de services, nombre d'environnements) estimez-vous que Helm devient indispensable plutôt que simplement utile ? Justifiez.

```txt
Helm devient indispensable dès qu’on dépasse un petit déploiement statique.

Dans notre cas, on a déjà plusieurs services :

  - user-service
  - task-service
  - notification-service
  - api-gateway
  - frontend
  - postgres
  - redis
  - ingress

et beaucoup de valeurs répétées : images, tags, ports, replicas, URLs, ressources, namespace.
Avec un seul environnement staging, Helm est déjà utile. Mais il devient vraiment indispensable dès qu’on a plusieurs environnements car il faut alors changer proprement :

  - les tags d’images
  - les ressources CPU/mémoire
  - les replicas
  - les secrets
  - les noms de domaine Ingress
  - les configurations de base de données
  - les limites réseau ou de sécurité

Sans Helm, on doit dupliquer ou modifier beaucoup de YAML à la main, ce qui augmente fortement le risque d’erreur. Avec Helm, on garde les mêmes templates et on change seulement les fichiers de valeurs, par exemple values-staging.yaml et values-production.yaml.
```


---

## Partie A - Application Taskflow

### Étape 1 - Créer le chart de Taskflow

Un dossier `helm` est déjà créé, contenant quelques fichiers complets : 
- `helm/Chart.yaml`
- `helm/taskflow/templates/user-service.yaml`
- `helm/taskflow/templates/postgres.yaml`
- `helm/values.production.yaml`

---

#### Manipulations

* À vous maintenant de créer tous les autres services (sauf redis: cf section suivante) en suivant le template. Vous retrouverez également un fichier `values.yaml` à compléter.

Vous avez écrit un template Redis maison avec Kubernetes.
Helm permet de déléguer cette responsabilité à un chart Bitnami maintenu par la communauté.

 * Ajoutez la dépendance à Redis dans le fichier `helm/Chart.yaml` et inspectez les fichiers `values` afin d'identifier comment le service est configuré. 

* Téléchargez le sous-chart :

```bash
helm dependency update ./helm/taskflow
```

* Vérifiez que le Service Redis généré s'appelle bien `redis-master` :

```bash
helm template taskflow ./helm/taskflow \
  --values ./helm/taskflow/values.yaml \
  --show-only charts/redis/templates/master/service.yaml
```

> **Note :** Dans le chart Bitnami Redis 18.x, le Service du master est toujours nommé `{fullname}-master`, même avec `fullnameOverride: redis`. Le Service s'appelle donc `redis-master` et non `redis`.

* Mettez à jour vos variables `REDIS_URL` pour pointer vers le bon nom de service

```yaml
value: redis://redis-master:6379
```

---

#### Réflexion théorique — Répondez dans votre `REPORT.md`

> 1. En vous appuyant sur le critère vu en cours, justifiez pourquoi Redis se prête à un chart officiel.

```text
Redis se prête à un chart officiel parce que c’est un composant d’infrastructure générique et standard. Sa configuration n’est pas spécifique à TaskFlow : port 6379, Service Kubernetes, probes, ressources, auth, persistance éventuelle, réplication ou mode standalone. Ce sont des besoins communs à beaucoup de projets, donc il est préférable d’utiliser un chart maintenu par la communauté comme Bitnami Redis plutôt que de maintenir un template maison.
```

> 2. Pourquoi a-t-on conservé un template maison pour PostgreSQL plutôt que d'utiliser `bitnami/postgresql` ?
> Identifiez les deux éléments de votre configuration Postgres actuelle qui rendraient la migration vers Bitnami coûteuse.

```text
On a conservé un template maison pour PostgreSQL parce que notre configuration est plus spécifique au projet. Deux éléments rendent une migration vers bitnami/postgresql coûteuse :
  - le script d’initialisation SQL custom, monté dans /docker-entrypoint-initdb.d, qui crée les tables users, tasks, notifications et insère des données de départ
  - le Secret maison et les variables associées (POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB), utilisées pour construire les DATABASE_URL des services applicatifs

Avec Bitnami, il faudrait adapter les noms de Secrets, les clés, le mécanisme d’initialisation et les chaînes de connexion attendues par les services.
```
---

### Étape 2 — Values par environnement

`values.production.yaml` surcharge les valeurs par défaut avec des valeurs de production. Avant d'aller plus loin, observez ce fichier.

> Des valeurs sensibles (mot de passe, token JWT...) sont présentes dans ce fichier, vous avez un problème : ce fichier est versionné dans Git — même dans un repo privé.

```text
values.production.yaml est versionné, donc il ne doit pas contenir de secrets réels comme un mot de passe PostgreSQL, un token JWT, une clé API ou un secret Docker.
Même dans un repo privé, un secret versionné est considéré comme compromis, car il peut être lu par toutes les personnes ayant accès au dépôt, rester dans l’historique Git, être copié dans des forks, logs CI/CD ou artefacts.

La bonne approche est de ne garder dans values.production.yaml que des placeholders non sensibles, par exemple :

postgres:
  password: REMPLACER_PAR_MOT_DE_PASSE_FORT

apiGateway:
  jwtSecret: REMPLACER_PAR_SECRET_JWT_FORT

Puis fournir les vraies valeurs au moment du déploiement via un mécanisme externe :

  helm upgrade --install taskflow ./helm/taskflow \
    -n production \
    -f helm/taskflow/values.production.yaml \
    --set postgres.password="$POSTGRES_PASSWORD" \
    --set apiGateway.jwtSecret="$JWT_SECRET"

En production, on utiliserait plutôt un gestionnaire de secrets : Kubernetes Secret créé séparément, Sealed Secrets, External Secrets Operator, Vault, AWS Secrets Manager, etc.
```

---

#### Réflexion théorique — Répondez dans votre `REPORT.md`

> 1. Comment déployer avec des valeurs sensibles sans les commiter ? Sortez les valeurs sensibles des fichiers commités
>

```text
On sort les secrets des fichiers versionnés et on les injecte au moment du déploiement.

Exemple avec des variables d’environnement locales :

  export POSTGRES_PASSWORD='mot-de-passe-fort'
  export JWT_SECRET='secret-jwt-fort'

Puis :

  helm upgrade --install taskflow ./helm/taskflow \
    -n production \
    -f helm/taskflow/values.production.yaml \
    --set-string postgres.password="$POSTGRES_PASSWORD" \
    --set-string apiGateway.jwtSecret="$JWT_SECRET"

On peut aussi créer les Secret Kubernetes séparément, puis faire référencer ces secrets par le chart au lieu de générer les secrets depuis values.yaml.
```

> 2. Expliquez pourquoi la solution que vous venez de trouver est plus sûre que de mettre les valeurs dans `values.production.yaml`, même si ce fichier est dans un dépôt privé.
>
```text
Parce que les secrets ne sont pas stockés dans Git.
Un repo privé reste accessible à plusieurs personnes, peut être cloné, forké, exposé par erreur, ou utilisé par la CI. Et surtout, si un secret est commité, il reste dans l’historique Git même après suppression.
Avec des variables d’environnement ou un secret manager, les valeurs sensibles ne sont fournies qu’au moment du déploiement. Elles ne sont pas présentes dans le dépôt, ni dans
l’historique.
```

> 3. `helm-secrets` est un plugin qui chiffre les fichiers de valeurs (via GPG ou AWS KMS) et les déchiffre à la volée au moment du `helm upgrade`.
> Quel problème résout-il que votre solution ne résout pas ? Dans quel contexte deviendrait-il nécessaire ?
>
```text
Notre solution évite de commiter les secrets, mais elle ne permet pas de versionner proprement les valeurs sensibles. 
helm-secrets résout ce problème : il permet de commiter un fichier de valeurs chiffré, par exemple secrets.production.yaml, sans exposer son contenu en clair.

Il devient nécessaire quand :

  - plusieurs personnes ou environnements doivent partager les mêmes secrets de manière contrôlée
  - on veut versionner les changements de secrets
  - on veut du GitOps avec tout le déploiement décrit dans Git
  - la CI/CD doit déployer sans que quelqu’un injecte manuellement les valeurs
  - on utilise GPG, SOPS, AWS KMS, Vault ou un autre système de chiffrement centralisé
```

> 4. Dans GitHub Actions, comment feriez-vous pour passer `$POSTGRES_PASSWORD` dans une commande `helm upgrade` sans qu'il apparaisse en clair dans les logs du workflow ?

```text
On stocke le secret dans GitHub Actions Secrets, par exemple :

  POSTGRES_PASSWORD
  JWT_SECRET

Puis dans le workflow :

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

GitHub masque automatiquement les valeurs issues de secrets.* dans les logs. Il faut éviter de faire echo $POSTGRES_PASSWORD ou d’activer un mode debug qui affiche les commandes avec leurs valeurs expansées.
```

---

### Étape 3 — Installation du chart

Avant toute installation ou mise à jour sur le cluster, générez le YAML final pour vérifier que tout est correct.

Générez le rendu complet, puis filtrez sur le template du task-service uniquement.

#### Réflexion théorique — Répondez dans votre `REPORT.md`

> 1. Que se passe-t-il si une variable référencée dans un template n'a pas de valeur correspondante dans values.yaml ? Vérifiez par vous-même en supprimant temporairement une valeur.
>

```text
Ça dépend de la manière dont elle est référencée.

On as vérifié avec :

  helm template taskflow ./helm/taskflow \
    --namespace staging \
    --values ./helm/taskflow/values.yaml \
    --show-only templates/task-service.yaml \
    --set-json taskService=null

Résultat :

  Error: template: taskflow/templates/task-service.yaml:20:22:
  executing "taskflow/templates/task-service.yaml" at <.Values.taskService.replicaCount>:
  nil pointer evaluating interface {}.replicaCount

Donc ici Helm échoue avant même de générer le YAML, parce que le template essaie d’accéder à :

  .Values.taskService.replicaCount

alors que taskService n’existe plus.

Dans d’autres cas, si seule une valeur simple manque, Helm peut rendre <no value> ou produire un YAML invalide. C’est pour ça qu’il faut toujours vérifier avec :

  helm template ...
  helm lint ...

et utiliser des valeurs par défaut quand c’est pertinent, par exemple :

  {{ .Values.taskService.tag | default .Values.image.tag }}
```

> 2. Comparez la sortie de helm template sur votre task-service avec le fichier k8s/base/task-service/deployment.yaml écrit en partie 1. Quelles différences structurelles observez-vous ? Pourquoi existent-elles ?

```text
Le fichier manuel k8s/base/task-service/deployment.yaml contient seulement le Deployment.

Le rendu Helm de templates/task-service.yaml génère trois objets dans un seul template :

  ConfigMap
  Service
  Deployment

Différences structurelles observées :

  - Helm ajoute des commentaires de source :

  # Source: taskflow/templates/task-service.yaml

  - Helm remplace les variables par les valeurs finales :

  image: "lordtibu/taskflow-task-service:v1.0.0"
  replicas: 2
  REDIS_URL: "redis://redis-master:6379"

  - Le YAML généré par Helm contient la ConfigMap et le Service avec le Deployment, alors que dans k8s/base/, ces ressources sont séparées en plusieurs fichiers :

  configmap.yaml
  service.yaml
  deployment.yaml

  - L’ordre des clés peut changer légèrement. Par exemple les ressources sont rendues comme :

  limits:
    cpu: 300m
    memory: 256Mi
  requests:
    cpu: 100m
    memory: 128Mi

alors que le fichier manuel avait requests avant limits.

Ces différences existent parce que Helm ne stocke pas directement les manifests finaux. Il stocke des templates paramétrables, puis génère le YAML final à partir de values.yaml. Le but est d’éviter la duplication et de pouvoir changer les valeurs selon l’environnement sans réécrire tous les manifests.
```

#### Installer

```bash
# Désinstaller ce qui tourne déjà en staging
kubectl delete namespace staging
kubectl create namespace staging

# Installer via Helm
helm upgrade --install taskflow ./helm/taskflow \
  --namespace staging \
  --values ./helm/taskflow/values.yaml
```

Vérifiez :

```bash
helm list -n staging
kubectl get all -n staging
```

---

### Étape 4 — Tester une mise à jour

Il existe un plugin Helm qui permet de visualiser l'impact d'un `helm upgrade` avant de l'appliquer.
* Trouvez-le, installez-le, et utilisez-le pour prévisualiser le changement avant de modifier.
* Effectuer la modification suivante : "Rajouter une instance au service de notification"

> 1. Montrez dans `REPORT.md` votre modification, la commande de prévisualisation et sa sortie.
>
```text
Plugin utilisé : helm-diff.

Commande :

  helm diff upgrade taskflow ./helm/taskflow \
    -n staging \
    --values ./helm/taskflow/values.yaml

Sortie importante :

  staging, notification-service, Deployment (apps) has changed:
    spec:
  -   replicas: 1
  +   replicas: 2

Cette sortie montre que le prochain helm upgrade va modifier le Deployment notification-service en passant de 1 à 2 replicas.
```
> 2. Dans quel scénario cet outil est-il particulièrement critique — un changement de `replicaCount` ou un changement de `image.<service>.tag` ? Justifiez en vous appuyant sur ce que vous savez du rolling update Kubernetes.

```text
helm-diff est particulièrement critique lors d’un changement de image.<service>.tag.

Un changement de replicaCount modifie surtout le nombre de pods. Kubernetes ajoute ou retire des replicas, et le Service n’envoie du trafic qu’aux pods Ready.

Un changement de tag d’image déclenche un rolling update. Kubernetes crée des pods avec la nouvelle image, attend qu’ils soient Ready, puis remplace progressivement les anciens. Si la nouvelle image contient un bug mais passe quand même la readiness probe, Kubernetes peut remplacer une version saine par une version cassée.

helm-diff permet donc de vérifier avant l’upgrade quelle image va changer, sur quel service, et avec quel tag exact. C’est plus risqué qu’un simple changement de replicaCount.
```

#### Appliquer et observer

```bash
helm upgrade taskflow ./helm/taskflow \
  --namespace staging \
  --values ./helm/taskflow/values.yaml
```

Observez le rolling update dans une fenêtre avec `watch kubectl get pods -n staging -o wide`.

Testez le rollback :

```bash
helm rollback taskflow 1 -n staging
```

Consultez l'historique avec la commande : 

```bash
helm history taskflow -n staging
```

---

#### Réflexion théorique — Historique des déploiements

> Répondez dans votre `REPORT.md` :
> 1. Décrivez ce que vous avez vu avec `watch kubectl get pods -n staging -o wide`.
```text
Pendant les déploiements et upgrades, on voit Kubernetes faire évoluer les pods progressivement.

Par exemple, lors d’un changement de replicas, un nouveau pod apparaît d’abord en cours de création :

  0/1 ContainerCreating

Puis il passe en :

  1/1 Running

Avec -o wide, on voit aussi sur quel noeud chaque pod est schedulé, par exemple taskflow-worker ou taskflow-worker2.

Lors d’un rolling update, on peut voir temporairement les anciens pods et les nouveaux pods cohabiter. Kubernetes garde les anciens pods disponibles tant que les nouveaux ne sont pas prêts, ce qui évite une interruption de service.
``

> 2. Quelle information présente dans `helm history` est absente de `kubectl rollout history` et pourquoi est-elle critique en production ?

```text
helm history donne une vision au niveau de la release Helm complète. Il affiche notamment :

  - le numéro de révision Helm
  - la date du déploiement
  - le statut de la release
  - le chart utilisé
  - l’app version
  - la description de l’action, par exemple Install complete, Upgrade complete, Rollback to 1

kubectl rollout history est limité à un Deployment précis. Il montre les révisions Kubernetes du Deployment, mais il ne sait pas quelle release Helm complète a été installée ou mise à jour.

Cette information est critique en production parce qu’une application ne se résume pas à un seul Deployment. Un déploiement peut modifier en même temps :

  - un Deployment
  - une ConfigMap
  - un Secret
  - un Service
  - un Ingress
  - un sous-chart comme Redis

Avec helm history, on sait quelle révision globale de l’application a été déployée et on peut revenir à un état cohérent.
```

> 3. `helm rollback taskflow 1` et `kubectl rollout undo deployment/task-service` semblent faire la même chose. Quelle est la différence fondamentale quand votre application déploie plusieurs ressources (Deployment, Service, ConfigMap) en même temps ?

```text
kubectl rollout undo deployment/task-service rollback uniquement le Deployment task-service.

Il ne rollback pas les autres ressources associées, par exemple :

  - ConfigMap
  - Secret
  - Service
  - Ingress
  - autres Deployments
  - dépendances Helm comme Redis

Donc si un upgrade a modifié à la fois l’image du task-service, une variable dans une ConfigMap et une règle Ingress, kubectl rollout undo ne revient pas à l’état complet précédent. Il ne corrige qu’une partie.

helm rollback taskflow 1, lui, rollback toute la release Helm taskflow vers la révision 1. Il restaure l’ensemble des ressources gérées par Helm dans un état cohérent : Deployments, Services, ConfigMaps, Ingress, PostgreSQL template, Redis chart, etc.

La différence fondamentale est donc le périmètre :

  kubectl rollout undo = rollback d’un seul Deployment
  helm rollback = rollback de toute la release applicative

En production, Helm est plus adapté pour revenir à une version cohérente de l’application complète.
```
---

## Livrable

**Chart TaskFlow**
- Dossier `helm/taskflow/` versionné avec chart complet
- `values.yaml` et `values.production.yaml` présents — aucun secret en clair

**REPORT.md**
- Réponses à toutes les questions théoriques encadrées