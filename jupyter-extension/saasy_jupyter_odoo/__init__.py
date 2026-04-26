"""Saasy JupyterLab extension for Odoo admin (update / logs / restart)."""
from .handlers import setup_handlers


__version__ = "0.1.0"


def _jupyter_server_extension_paths():
    return [{"module": "saasy_jupyter_odoo"}]


def _jupyter_server_extension_points():
    """Returns a list of dictionaries with metadata describing
    where to find the `_load_jupyter_server_extension` function."""
    return [{"module": "saasy_jupyter_odoo"}]


def _load_jupyter_server_extension(server_app):
    """Called when the Jupyter server starts."""
    setup_handlers(server_app.web_app)
    server_app.log.info("[saasy_jupyter_odoo] Extension loaded")


# Backward-compat name expected by older Jupyter versions
load_jupyter_server_extension = _load_jupyter_server_extension
