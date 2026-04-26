import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { Dialog, showDialog, Notification } from '@jupyterlab/apputils';
import { IMainMenu } from '@jupyterlab/mainmenu';
import { INotebookTracker } from '@jupyterlab/notebook';
import { Menu } from '@lumino/widgets';

import { requestAPI } from './handler';

namespace CommandIDs {
  export const updateModule = 'saasy-odoo:update-module';
  export const showLogs = 'saasy-odoo:show-logs';
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
    async function detectCurrentModule(): Promise<string | null> {
      const widget = app.shell.currentWidget;
      const path = (widget as any)?.context?.path || '';
      if (!path) return null;
      try {
        const resp = await requestAPI<ICurrentModuleResponse>(
          `current-module?path=${encodeURIComponent(`/mnt/extra-addons/${path}`)}`
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

    // ── Restart ────────────────────────────────────────────────────────────
    commands.addCommand(CommandIDs.restart, {
      label: 'Restart Odoo',
      caption: 'Restart the Odoo container (sessions will be interrupted)',
      execute: async () => {
        const result = await showDialog({
          title: 'Restart Odoo?',
          body: 'This will restart the Odoo container. Active user sessions will be briefly interrupted.',
          buttons: [
            Dialog.cancelButton(),
            Dialog.warnButton({ label: 'Restart' })
          ]
        });
        if (!result.button.accept) return;
        const notif = Notification.emit('Restarting Odoo…', 'in-progress', {
          autoClose: false
        });
        try {
          const resp = await requestAPI<{ ok: boolean; stderr: string }>('restart', {
            method: 'POST'
          });
          Notification.dismiss(notif);
          if (resp.ok) {
            Notification.success('Odoo restarted');
          } else {
            Notification.error(`Restart failed: ${resp.stderr}`);
          }
        } catch (err) {
          Notification.dismiss(notif);
          Notification.error(`Restart failed: ${(err as Error).message}`);
        }
      }
    });

    // ── Build menu ─────────────────────────────────────────────────────────
    const menu = new Menu({ commands });
    menu.title.label = 'Odoo';
    menu.addItem({ command: CommandIDs.updateModule });
    menu.addItem({ command: CommandIDs.showLogs });
    menu.addItem({ type: 'separator' });
    menu.addItem({ command: CommandIDs.restart });
    mainMenu.addMenu(menu, false, { rank: 100 });

    // Avoid unused warning
    void notebookTracker;
  }
};

export default plugin;

// ── Small input widget for module prompt ─────────────────────────────────
import { Widget } from '@lumino/widgets';

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
