"""Tornado handlers for Odoo admin operations exposed to JupyterLab."""
import asyncio
import json
import os
import subprocess
from typing import Optional

from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join
import tornado
from tornado.iostream import StreamClosedError


ODOO_CONTAINER = os.environ.get("ODOO_CONTAINER", "odoo")
ODOO_DB = os.environ.get("ODOO_DB", "odoo")
ODOO_RC = os.environ.get("ODOO_RC", "/etc/odoo/odoo.conf")


def _run(cmd: list[str], timeout: int = 600) -> dict:
    """Run a subprocess and return stdout/stderr/returncode."""
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return {
            "returncode": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "ok": proc.returncode == 0,
        }
    except subprocess.TimeoutExpired:
        return {"returncode": -1, "stdout": "", "stderr": f"Timeout apres {timeout}s", "ok": False}
    except Exception as exc:  # noqa: BLE001
        return {"returncode": -1, "stdout": "", "stderr": str(exc), "ok": False}


def _detect_module_from_path(path: str) -> Optional[str]:
    """Try to extract the Odoo module name from a file path.

    A module is the directory directly under /mnt/extra-addons/ that
    contains a __manifest__.py. Accepts multiple path formats :
      /mnt/extra-addons/saasy/views/foo.xml         -> "saasy"
      /mnt/extra-addons/saasy-odoo-addon/saasy/...  -> "saasy"
      addons/saasy/views/foo.xml                    -> "saasy" (relative to JupyterLab root_dir)
      addons/saasy-odoo-addon/saasy/...             -> "saasy"
    """
    if not path:
        return None

    # Normalise: extract the part after /mnt/extra-addons/ or addons/
    rel = None
    for marker in ("/mnt/extra-addons/", "/home/jovyan/work/addons/", "addons/"):
        if marker in path:
            rel = path.split(marker, 1)[1]
            break
    if rel is None:
        return None

    parts = [p for p in rel.split("/") if p]
    if not parts:
        return None

    # Cherche le premier dossier qui contient un __manifest__.py
    base = "/mnt/extra-addons"
    for i in range(len(parts)):
        candidate = os.path.join(base, *parts[: i + 1])
        manifest = os.path.join(candidate, "__manifest__.py")
        if os.path.isfile(manifest):
            return parts[i]

    return None


class UpdateModuleHandler(APIHandler):
    """POST /saasy-odoo/update?module=<name>"""

    @tornado.web.authenticated
    def post(self):
        module = self.get_argument("module", "")
        if not module:
            self.set_status(400)
            self.finish(json.dumps({"error": "module argument is required"}))
            return

        # Securite : on valide que c'est un nom de module simple
        if not module.replace("_", "").replace("-", "").isalnum():
            self.set_status(400)
            self.finish(json.dumps({"error": "module name invalide"}))
            return

        result = _run(
            [
                "docker",
                "exec",
                ODOO_CONTAINER,
                "odoo",
                "-c",
                ODOO_RC,
                "-d",
                ODOO_DB,
                "-u",
                module,
                "--stop-after-init",
                "--no-http",
            ],
            timeout=600,
        )
        # 200 meme si erreur Odoo : le frontend affiche stderr
        self.finish(json.dumps({"module": module, **result}))


class ServerLogsHandler(APIHandler):
    """GET /saasy-odoo/logs?tail=200"""

    @tornado.web.authenticated
    def get(self):
        try:
            tail = int(self.get_argument("tail", "200"))
        except ValueError:
            tail = 200
        tail = min(max(tail, 1), 5000)

        result = _run(
            ["docker", "logs", f"--tail={tail}", ODOO_CONTAINER],
            timeout=30,
        )
        # docker logs ecrit sur stderr pour les logs Odoo, donc on combine
        logs = (result["stderr"] or "") + (result["stdout"] or "")
        self.finish(json.dumps({"logs": logs, "ok": result["ok"]}))


class RestartHandler(APIHandler):
    """POST /saasy-odoo/restart"""

    @tornado.web.authenticated
    def post(self):
        result = _run(["docker", "restart", ODOO_CONTAINER], timeout=60)
        self.finish(json.dumps(result))


class LogsStreamHandler(APIHandler):
    """SSE: GET /saasy-odoo/logs/stream?tail=50

    Stream `docker logs -f --tail=N <container>` line by line as Server-Sent
    Events. Each event has format `data: {"line": "..."}`. The connection
    stays open until the client closes it (or the container stops).
    """

    @tornado.web.authenticated
    async def get(self):
        try:
            tail = int(self.get_argument("tail", "50"))
        except ValueError:
            tail = 50
        tail = min(max(tail, 0), 1000)

        self.set_header("Content-Type", "text/event-stream")
        self.set_header("Cache-Control", "no-cache")
        self.set_header("X-Accel-Buffering", "no")  # disable Nginx buffering
        self.set_header("Connection", "keep-alive")

        # Spawn docker logs -f as a subprocess, stream its stdout
        proc = await asyncio.create_subprocess_exec(
            "docker", "logs", "-f", f"--tail={tail}", ODOO_CONTAINER,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

        try:
            # Initial event so the client knows the stream is live
            self.write('data: {"line":"[connected to docker logs]\\n"}\n\n')
            await self.flush()

            while True:
                line_bytes = await proc.stdout.readline()
                if not line_bytes:
                    break
                line = line_bytes.decode("utf-8", errors="replace")
                # SSE format: data: <json>\n\n
                self.write(f"data: {json.dumps({'line': line})}\n\n")
                await self.flush()
        except (StreamClosedError, ConnectionResetError):
            # Client closed the connection — clean shutdown
            pass
        finally:
            try:
                proc.terminate()
                await asyncio.wait_for(proc.wait(), timeout=2)
            except asyncio.TimeoutError:
                proc.kill()


class CurrentModuleHandler(APIHandler):
    """GET /saasy-odoo/current-module?path=<file-path>

    Returne le nom du module Odoo correspondant au path donne (ou null).
    Le path est typiquement le path du notebook actuellement actif dans
    JupyterLab (ex: /mnt/extra-addons/saasy/notes.ipynb).
    """

    @tornado.web.authenticated
    def get(self):
        path = self.get_argument("path", "")
        module = _detect_module_from_path(path)
        self.finish(json.dumps({"path": path, "module": module}))


def setup_handlers(web_app):
    base_url = web_app.settings["base_url"]
    handlers = [
        (url_path_join(base_url, "saasy-odoo", "update"), UpdateModuleHandler),
        (url_path_join(base_url, "saasy-odoo", "logs"), ServerLogsHandler),
        (url_path_join(base_url, "saasy-odoo", "logs", "stream"), LogsStreamHandler),
        (url_path_join(base_url, "saasy-odoo", "restart"), RestartHandler),
        (url_path_join(base_url, "saasy-odoo", "current-module"), CurrentModuleHandler),
    ]
    web_app.add_handlers(".*$", handlers)
