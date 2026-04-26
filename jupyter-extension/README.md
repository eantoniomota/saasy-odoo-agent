# saasy_jupyter_odoo

Extension JupyterLab qui ajoute un menu "Odoo" pour administrer le container Odoo depuis JupyterLab :

- **Update Module** : update du module Odoo correspondant au notebook actif
- **Server Logs** : affichage des logs Odoo (last 200 lignes)
- **Restart** : redémarrage du container Odoo

## Architecture

- **Server extension** (Python) : endpoints HTTP `/saasy-odoo/*` qui exécutent `docker exec/restart` via le socket Docker monté
- **Frontend extension** (TypeScript) : menu top-bar dans JupyterLab qui appelle les endpoints

## Pré-requis

Le container Jupyter doit avoir :
- `/var/run/docker.sock` monté (pour exécuter des commandes Docker)
- Le container `odoo` accessible (par défaut nommé `odoo`)
- `/mnt/extra-addons` monté (pour la détection auto du module courant)

Variables d'env :
- `ODOO_CONTAINER` : nom du container Odoo (défaut : `odoo`)
- `ODOO_DB` : nom de la base Odoo (défaut : `odoo`)
- `ODOO_RC` : chemin du fichier config Odoo (défaut : `/etc/odoo/odoo.conf`)

## Installation (dans une image Jupyter)

```bash
pip install saasy_jupyter_odoo
```

## Build local (pour développement)

```bash
# Installer en mode editable
pip install -e .

# Pour le frontend (à venir)
cd ../jupyter-extension-frontend
jlpm install
jlpm run build:prod
```

## API HTTP exposée

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/saasy-odoo/update?module=<name>` | POST | Update le module Odoo donné (`odoo -u <name>`) |
| `/saasy-odoo/logs?tail=200` | GET | Retourne les `tail` dernières lignes de logs |
| `/saasy-odoo/restart` | POST | `docker restart <ODOO_CONTAINER>` |
| `/saasy-odoo/current-module?path=<file>` | GET | Détecte le module depuis un path (cherche `__manifest__.py`) |

Tous les endpoints requièrent l'auth JupyterLab standard (token).
