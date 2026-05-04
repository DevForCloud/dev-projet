#!/bin/bash
set -e

DOCKER_USER="${1:-jplande}"
TAG="${2:-v1.0.0}"

echo "Cleaning Docker cache..."
docker system prune -f
echo ""

echo "Building and pushing images for user: $DOCKER_USER, tag: $TAG"
echo ""

SERVICES=("user-service" "task-service" "notification-service" "api-gateway" "frontend")

for SERVICE in "${SERVICES[@]}"; do
  IMAGE="$DOCKER_USER/taskflow-$SERVICE:$TAG"
  echo ">>> Building $IMAGE"
  docker build --no-cache -t "$IMAGE" "./$SERVICE"
  echo ">>> Pushing $IMAGE"
  docker push "$IMAGE"
  echo ""
done

echo "All images pushed successfully."
