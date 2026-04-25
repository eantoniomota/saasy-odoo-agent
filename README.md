# Saasy Agent

Agent de monitoring d'infrastructure pour la plateforme [Saasy](https://saasy.fr).

Collecte les métriques système, les stats Docker et les logs depuis un serveur client, puis les envoie à l'API Saasy.

## Fonctionnalités

- Collecte de métriques système (CPU, RAM, disques, réseau)
- Collecte des stats des containers Docker
- Streaming de logs Docker
- Heartbeat périodique
- Kernels Jupyter (Python, Node, Bash, Odoo) pilotés à distance

## Installation

### Option 1 — Docker (recommandé)

```bash
docker run -d \
  --name saasy-agent \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e SAASY_API_URL=https://api.saasy.fr \
  -e SAASY_AGENT_KEY=fbk_xxxxxxxxxxxxxxxx \
  -e SAASY_SERVER_ID=xxxxxxxxxxxxxxxx \
  saasy/agent:latest
```

### Option 2 — npm

```bash
npm install -g @saasy/agent
SAASY_API_URL=https://api.saasy.fr \
SAASY_AGENT_KEY=fbk_xxx \
SAASY_SERVER_ID=xxx \
saasy-agent
```

### Option 3 — depuis les sources

```bash
git clone https://github.com/<votre-org>/saasy-agent.git
cd saasy-agent
npm install
cp .env.example .env  # remplir les variables
npm run build
npm start
```

## Configuration

Voir [`.env.example`](./.env.example) pour la liste complète des variables.

| Variable | Requis | Défaut | Description |
|----------|--------|--------|-------------|
| `SAASY_API_URL` | oui | — | URL de l'API Saasy |
| `SAASY_AGENT_KEY` | oui | — | Clé API avec scope `infra:metrics:write` + `infra:logs:write` |
| `SAASY_SERVER_ID` | oui | — | ID du serveur (généré dans le dashboard Saasy) |
| `COLLECT_INTERVAL` | non | `30` | Intervalle de collecte des métriques (s) |
| `LOG_FLUSH_INTERVAL` | non | `10` | Intervalle de flush des logs (s) |
| `HEARTBEAT_INTERVAL` | non | `60` | Intervalle de heartbeat (s) |
| `DOCKER_SOCKET` | non | `/var/run/docker.sock` | Socket Docker |
| `LOG_CONTAINERS` | non | (tous) | Containers à logger (séparés par virgule) |
| `AGENT_HOSTNAME` | non | hostname système | Override du hostname |

## Développement

```bash
npm run dev        # mode watch
npm run typecheck  # vérification TypeScript
npm test           # tests Jest
npm run build      # build production
```

## Licence

Propriétaire — Copyright © 2026 Saasy. Tous droits réservés. Voir [LICENSE](./LICENSE).
