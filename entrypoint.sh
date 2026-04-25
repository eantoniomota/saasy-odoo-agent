#!/bin/sh
set -e

# Si /var/run/docker.sock est monte, ajuster dynamiquement le groupe
# pour que le user 'agent' (non-root) puisse y acceder.
# Cela evite d'avoir a passer --group-add au runtime.
if [ -S /var/run/docker.sock ]; then
  DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)

  # Trouver un groupe existant avec ce GID, sinon en creer un
  GROUP_NAME=$(getent group "$DOCKER_GID" | cut -d: -f1)
  if [ -z "$GROUP_NAME" ]; then
    addgroup -g "$DOCKER_GID" dockerhost
    GROUP_NAME="dockerhost"
  fi

  # Ajouter 'agent' au groupe (idempotent)
  addgroup agent "$GROUP_NAME" 2>/dev/null || true
fi

# Drop privileges et exec la commande en tant que 'agent'
exec su-exec agent "$@"
