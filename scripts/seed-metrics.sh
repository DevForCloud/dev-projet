#!/bin/bash
# seed-metrics.sh — Génère des données pour les dashboards Grafana
# Usage: bash scripts/seed-metrics.sh

BASE_URL="http://localhost:3000"
EMAIL="demo@taskflow.com"
PASSWORD="demo1234"
NAME="Demo User"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[OK]${NC} $1"; }
info() { echo -e "${YELLOW}[..] $1${NC}"; }
err()  { echo -e "${RED}[ERR]${NC} $1"; }

# ─────────────────────────────────────────────
# 1. Enregistrement / Login
# ─────────────────────────────────────────────
info "Inscription de l'utilisateur demo..."
curl -s -X POST "$BASE_URL/api/users/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"$NAME\"}" > /dev/null

info "Login..."
RESPONSE=$(curl -s -X POST "$BASE_URL/api/users/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")

TOKEN=$(echo "$RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
USER_ID=$(echo "$RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  err "Impossible de récupérer le token. Vérifie que les services tournent."
  echo "Réponse: $RESPONSE"
  exit 1
fi
log "Token récupéré (user_id: $USER_ID)"

# ─────────────────────────────────────────────
# 2. Créer des tâches (priorités variées)
#    → tasks_created_total{priority}
# ─────────────────────────────────────────────
info "Création des tâches..."

create_task() {
  local title="$1"
  local priority="$2"
  RESULT=$(curl -s -X POST "$BASE_URL/api/tasks" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"title\":\"$title\",\"priority\":\"$priority\",\"created_by\":\"$USER_ID\"}")
  echo "$RESULT" | grep -o '"id":"[^"]*"' | cut -d'"' -f4
}

T1=$(create_task "Corriger bug de paiement" "high")
T2=$(create_task "Optimiser les requêtes DB" "high")
T3=$(create_task "Ajouter feature export CSV" "medium")
T4=$(create_task "Mettre à jour la documentation" "medium")
T5=$(create_task "Refactorer le module auth" "medium")
T6=$(create_task "Changer la couleur du bouton" "low")
T7=$(create_task "Vérifier les logs de prod" "low")

log "7 tâches créées (2 high, 3 medium, 2 low)"

# ─────────────────────────────────────────────
# 3. Changer les statuts
#    → tasks_status_changes_total{from_status, to_status}
# ─────────────────────────────────────────────
info "Changements de statut..."

change_status() {
  local id="$1"
  local status="$2"
  if [ -n "$id" ]; then
    curl -s -X PATCH "$BASE_URL/api/tasks/$id" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $TOKEN" \
      -d "{\"status\":\"$status\"}" > /dev/null
  fi
}

# todo -> in_progress
change_status "$T1" "in_progress"
change_status "$T2" "in_progress"
change_status "$T3" "in_progress"
change_status "$T4" "in_progress"

# in_progress -> done
change_status "$T1" "done"
change_status "$T3" "done"

# in_progress -> done (supplémentaires)
change_status "$T4" "done"
change_status "$T5" "in_progress"

log "Transitions: todo→in_progress (x4), in_progress→done (x3), todo→in_progress→done (x1)"

# ─────────────────────────────────────────────
# 4. Tentatives de connexion réussies/échouées
#    → user_login_attempts_total{success}
# ─────────────────────────────────────────────
info "Tentatives de connexion..."

# Succès
for i in 1 2 3; do
  curl -s -X POST "$BASE_URL/api/users/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" > /dev/null
done

# Échecs (mauvais mot de passe)
for i in 1 2; do
  curl -s -X POST "$BASE_URL/api/users/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"wrongpassword\"}" > /dev/null
done

# Échecs (utilisateur inconnu)
for i in 1 2; do
  curl -s -X POST "$BASE_URL/api/users/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"ghost@nowhere.com\",\"password\":\"whatever\"}" > /dev/null
done

log "Connexions: 3 succès, 4 échecs"

# ─────────────────────────────────────────────
# 5. Requêtes variées pour Dashboard 1
#    → http_requests_total, http_request_duration_ms, up
# ─────────────────────────────────────────────
info "Requêtes HTTP variées (Dashboard 1)..."

# GETs normaux
for i in $(seq 1 5); do
  curl -s "$BASE_URL/api/tasks" \
    -H "Authorization: Bearer $TOKEN" > /dev/null
done

# 500 via UUID invalide
for i in 1 2; do
  curl -s "$BASE_URL/api/tasks/not-a-uuid" \
    -H "Authorization: Bearer $TOKEN" > /dev/null
done

# 404
curl -s "$BASE_URL/api/tasks/00000000-0000-0000-0000-000000000000" \
  -H "Authorization: Bearer $TOKEN" > /dev/null

log "Requêtes variées envoyées (200, 404, 500)"

# ─────────────────────────────────────────────
echo ""
echo -e "${GREEN}✓ Seed terminé !${NC} Rafraîchis tes dashboards Grafana."
