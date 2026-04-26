import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { Dialog, showDialog, Notification } from '@jupyterlab/apputils';
import { URLExt } from '@jupyterlab/coreutils';
import { IMainMenu } from '@jupyterlab/mainmenu';
import { INotebookTracker } from '@jupyterlab/notebook';
import { ServerConnection } from '@jupyterlab/services';
import { Menu, Widget } from '@lumino/widgets';

import { requestAPI } from './handler';

namespace CommandIDs {
  export const updateModule = 'saasy-odoo:update-module';
  export const showLogs = 'saasy-odoo:show-logs';
  export const liveLogs = 'saasy-odoo:live-logs';
  export const restart = 'saasy-odoo:restart';
}

interface IUpdateResponse {
  module: string;
  ok: boolean;
  returncode: number;
  stdout: string;
  stderr: string;
}

interface ILogsResponse {
  logs: string;
  ok: boolean;
}

interface ICurrentModuleResponse {
  path: string;
  module: string | null;
}

/**
 * Initialization data for the saasy-jupyter-odoo extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'saasy-jupyter-odoo:plugin',
  description: 'Saasy Odoo admin menu for JupyterLab.',
  autoStart: true,
  requires: [IMainMenu, INotebookTracker],
  activate: (
    app: JupyterFrontEnd,
    mainMenu: IMainMenu,
    notebookTracker: INotebookTracker
  ) => {
    const { commands } = app;

    // ── Detect current module from active widget path ──────────────────────
    // Le path retourne par JupyterLab est relatif au root_dir (ex: "addons/saasy/views/foo.xml").
    // L'endpoint backend gere les prefixes /mnt/extra-addons/, /home/jovyan/work/addons/ et addons/.
    async function detectCurrentModule(): Promise<string | null> {
      const widget = app.shell.currentWidget;
      const path = (widget as any)?.context?.path || '';
      if (!path) return null;
      try {
        const resp = await requestAPI<ICurrentModuleResponse>(
          `current-module?path=${encodeURIComponent(path)}`
        );
        return resp.module;
      } catch {
        return null;
      }
    }

    // ── Update Module ──────────────────────────────────────────────────────
    commands.addCommand(CommandIDs.updateModule, {
      label: 'Update Module…',
      caption: 'Update the Odoo module of the currently open file',
      execute: async () => {
        const detected = await detectCurrentModule();
        const result = await showDialog({
          title: 'Update Odoo module',
          body: new ModulePromptWidget(detected || ''),
          buttons: [
            Dialog.cancelButton(),
            Dialog.okButton({ label: 'Update' })
          ]
        });
        if (!result.button.accept) return;
        const module = (result.value || '').trim();
        if (!module) {
          await showDialog({
            title: 'Update Odoo module',
            body: 'Module name is required.',
            buttons: [Dialog.okButton()]
          });
          return;
        }
        const notif = Notification.emit(`Updating module ${module}…`, 'in-progress', {
          autoClose: false
        });
        try {
          const resp = await requestAPI<IUpdateResponse>(
            `update?module=${encodeURIComponent(module)}`,
            { method: 'POST' }
          );
          Notification.dismiss(notif);
          if (resp.ok) {
            Notification.success(`Module ${module} updated successfully`);
          } else {
            await showDialog({
              title: `Update of ${module} failed`,
              body: (resp.stderr || resp.stdout || 'Unknown error').slice(-2000),
              buttons: [Dialog.okButton()]
            });
          }
        } catch (err) {
          Notification.dismiss(notif);
          Notification.error(`Update failed: ${(err as Error).message}`);
        }
      }
    });

    // ── Server Logs ────────────────────────────────────────────────────────
    commands.addCommand(CommandIDs.showLogs, {
      label: 'Server Logs…',
      caption: 'Show last 200 lines of Odoo container logs',
      execute: async () => {
        try {
          const resp = await requestAPI<ILogsResponse>('logs?tail=200');
          const body = document.createElement('div');
          const pre = document.createElement('pre');
          pre.style.maxHeight = '500px';
          pre.style.overflow = 'auto';
          pre.style.fontSize = '11px';
          pre.style.whiteSpace = 'pre-wrap';
          pre.textContent = resp.logs || '(no logs)';
          body.appendChild(pre);
          await showDialog({
            title: 'Odoo server logs (last 200 lines)',
            body: body as any,
            buttons: [Dialog.okButton({ label: 'Close' })]
          });
        } catch (err) {
          Notification.error(`Failed to fetch logs: ${(err as Error).message}`);
        }
      }
    });

    // ── Live Logs (streaming) ──────────────────────────────────────────────
    commands.addCommand(CommandIDs.liveLogs, {
      label: 'Live Logs (stream)…',
      caption: 'Open a shell-like window streaming Odoo logs in real-time',
      execute: () => openStreamingLogs('Odoo — Live Logs')
    });

    // ── Restart ────────────────────────────────────────────────────────────
    commands.addCommand(CommandIDs.restart, {
      label: 'Restart Odoo',
      caption: 'Restart the Odoo container — opens a live log shell',
      execute: async () => {
        const result = await showDialog({
          title: 'Restart Odoo?',
          body: 'This will restart the Odoo container. A live log window will open so you can watch the boot.',
          buttons: [
            Dialog.cancelButton(),
            Dialog.warnButton({ label: 'Restart' })
          ]
        });
        if (!result.button.accept) return;

        // Ouvre la fenetre shell AVANT le restart pour voir le boot
        openStreamingLogs('Odoo — Restarting…');

        // Lance le restart en parallele
        try {
          const resp = await requestAPI<{ ok: boolean; stderr: string }>('restart', {
            method: 'POST'
          });
          if (resp.ok) {
            Notification.success('Odoo restart initiated — see live logs window');
          } else {
            Notification.error(`Restart failed: ${resp.stderr}`);
          }
        } catch (err) {
          Notification.error(`Restart failed: ${(err as Error).message}`);
        }
      }
    });

    // ── Helper : ouvre un widget de streaming logs en MainArea ─────────────
    function openStreamingLogs(title: string): void {
      const widget = new StreamingLogsWidget();
      widget.id = `saasy-odoo-logs-${Date.now()}`;
      widget.title.label = title;
      widget.title.closable = true;
      app.shell.add(widget, 'main');
      app.shell.activateById(widget.id);
    }

    // ── Build menu ─────────────────────────────────────────────────────────
    const menu = new Menu({ commands });
    menu.title.label = 'Odoo';
    menu.addItem({ command: CommandIDs.updateModule });
    menu.addItem({ command: CommandIDs.showLogs });
    menu.addItem({ command: CommandIDs.liveLogs });
    menu.addItem({ type: 'separator' });
    menu.addItem({ command: CommandIDs.restart });
    mainMenu.addMenu(menu, false, { rank: 100 });

    // Avoid unused warning
    void notebookTracker;
  }
};

export default plugin;

// ── Small input widget for module prompt ─────────────────────────────────
class ModulePromptWidget extends Widget {
  constructor(defaultValue: string) {
    super();
    const input = document.createElement('input');
    input.type = 'text';
    input.value = defaultValue;
    input.placeholder = 'module_name';
    input.style.width = '100%';
    input.style.padding = '6px 8px';
    input.style.border = '1px solid #ccc';
    input.style.borderRadius = '4px';
    this.node.appendChild(document.createTextNode('Module to update:'));
    this.node.appendChild(document.createElement('br'));
    this.node.appendChild(input);
    this._input = input;
  }
  getValue(): string {
    return this._input.value;
  }
  private _input: HTMLInputElement;
}

// ── Streaming logs widget (terminal-like view) ───────────────────────────
class StreamingLogsWidget extends Widget {
  private _source: EventSource | null = null;
  private _pre: HTMLPreElement;

  constructor() {
    super();
    this.addClass('saasy-odoo-streaming-logs');
    this.node.style.background = '#0d1117';
    this.node.style.padding = '8px';
    this.node.style.height = '100%';
    this.node.style.boxSizing = 'border-box';
    this.node.style.overflow = 'hidden';
    this.node.style.display = 'flex';
    this.node.style.flexDirection = 'column';

    const header = document.createElement('div');
    header.textContent = '$ docker logs -f odoo  (Ctrl+Q to disconnect)';
    header.style.color = '#7ee787';
    header.style.fontFamily = 'monospace';
    header.style.fontSize = '11px';
    header.style.marginBottom = '6px';
    header.style.flexShrink = '0';
    this.node.appendChild(header);

    this._pre = document.createElement('pre');
    this._pre.style.flex = '1';
    this._pre.style.overflow = 'auto';
    this._pre.style.fontSize = '12px';
    this._pre.style.whiteSpace = 'pre-wrap';
    this._pre.style.wordBreak = 'break-all';
    this._pre.style.background = '#0d1117';
    this._pre.style.color = '#c9d1d9';
    this._pre.style.padding = '8px';
    this._pre.style.fontFamily = 'monospace';
    this._pre.style.margin = '0';
    this._pre.style.border = '1px solid #30363d';
    this._pre.style.borderRadius = '4px';
    this.node.appendChild(this._pre);

    this.startStream();
  }

  private startStream(): void {
    const settings = ServerConnection.makeSettings();
    const url = URLExt.join(settings.baseUrl, 'saasy-odoo', 'logs', 'stream');
    this._source = new EventSource(`${url}?tail=50`, { withCredentials: true });

    this._source.onmessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        this.appendLine(data.line || '');
      } catch {
        this.appendLine(e.data + '\n');
      }
    };

    this._source.onerror = () => {
      this.appendLine('\n[stream interrupted — reconnect by re-opening the window]\n');
      this._source?.close();
      this._source = null;
    };
  }

  private appendLine(line: string): void {
    const wasAtBottom =
      this._pre.scrollTop + this._pre.clientHeight >= this._pre.scrollHeight - 20;
    this._pre.appendChild(document.createTextNode(line));
    if (wasAtBottom) {
      this._pre.scrollTop = this._pre.scrollHeight;
    }
  }

  dispose(): void {
    this._source?.close();
    this._source = null;
    super.dispose();
  }
}
