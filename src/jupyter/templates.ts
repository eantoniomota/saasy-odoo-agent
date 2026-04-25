/**
 * Notebook templates pre-installed on Jupyter at install time.
 * Generic templates only — Odoo-specific templates live in kernels/odoo.ts
 */

export interface NotebookTemplate {
  name: string;
  filename: string;
  description: string;
  cells: NotebookCell[];
}

export interface NotebookCell {
  type: 'markdown' | 'code';
  source: string[];
}

export const GENERIC_TEMPLATES: NotebookTemplate[] = [
  {
    name: 'Bienvenue',
    filename: '00-welcome.ipynb',
    description: 'Introduction à Jupyter dans Saasy Infrastructure',
    cells: [
      {
        type: 'markdown',
        source: [
          '# Bienvenue dans Jupyter Saasy\n',
          '\n',
          'Tu es connecté au notebook de cet environnement.\n',
          '\n',
          '## Kernels disponibles\n',
          '- **Python 3** : scripts génériques\n',
          '- **Bash** : commandes shell sur le serveur\n',
          '- **Odoo** (si installé) : env Odoo pré-chargé\n',
          '\n',
          '## Persistance\n',
          'Tes notebooks sont sauvegardés sur le serveur dans `/home/jovyan/work/`.\n',
        ],
      },
      {
        type: 'code',
        source: ['import sys\n', 'print(f"Python {sys.version}")'],
      },
    ],
  },
  {
    name: 'Système',
    filename: '01-system-info.ipynb',
    description: 'Inspecter le système (CPU, RAM, processus)',
    cells: [
      {
        type: 'markdown',
        source: ['# Inspection système\n', 'Utilise le kernel **Bash** ou **Python**.'],
      },
      {
        type: 'code',
        source: ['import platform, psutil, os\n', '\n', 'print("OS:", platform.platform())\n', 'print("CPU:", psutil.cpu_percent(), "%")\n', 'print("RAM:", psutil.virtual_memory().percent, "%")\n', 'print("Disque /:", psutil.disk_usage("/").percent, "%")'],
      },
    ],
  },
];

/**
 * Render a NotebookTemplate to .ipynb JSON.
 */
export function renderNotebook(tpl: NotebookTemplate): string {
  const cells = tpl.cells.map((c) => ({
    cell_type: c.type,
    metadata: {},
    source: c.source,
    ...(c.type === 'code' ? { outputs: [], execution_count: null } : {}),
  }));

  return JSON.stringify(
    {
      cells,
      metadata: {
        kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
        language_info: { name: 'python' },
      },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    2,
  );
}
