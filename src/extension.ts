import * as vscode from 'vscode';
import * as path from 'path';

let activeExecutionTerminal: TinkerpadTerminal | undefined;
let warnedAboutDisabledEditorCodeLens = false;

const RUN_COMMAND = 'tinkerpad.runCurrentFile';
const DIAGNOSE_CODE_LENS_COMMAND = 'tinkerpad.diagnoseCodeLens';
const TERMINAL_NAME = 'Tinkerpad';
const DEFAULT_TINKER_COMMAND = 'php artisan tinker';
const DEFAULT_VERBOSE = false;
const CONFIG_DIRECTORY = '.tinkerpad';
const CONFIG_FILE = 'config.json';
const CODE_LENS_ENABLED_CONFIG = 'codeLens.enabled';
const OPEN_SETTINGS_ACTION = 'Open Settings';
const CODE_LENS_DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { language: 'php' },
  { pattern: '**/*.php' }
];

type TinkerpadConfig = {
  command: string;
  verbose: boolean;
};

type TinkerpadTerminal = Pick<vscode.Terminal, 'show' | 'sendText' | 'dispose'>;

type TinkerpadDocument = Pick<vscode.TextDocument, 'uri' | 'fileName' | 'languageId' | 'getText' | 'save'>;

type TinkerpadWorkspaceFolder = Pick<vscode.WorkspaceFolder, 'uri'>;

type TinkerpadExecutionServices = {
  getWorkspaceFolder(uri: vscode.Uri): TinkerpadWorkspaceFolder | undefined;
  getConfig(workspaceFolder: TinkerpadWorkspaceFolder): Promise<TinkerpadConfig | undefined>;
  createTerminal(cwd: string): TinkerpadTerminal;
  showErrorMessage(message: string): void;
  showWarningMessage(message: string): void;
};

export function activate(context: vscode.ExtensionContext): void {
  const runNormal = vscode.commands.registerCommand(RUN_COMMAND, async (uri?: vscode.Uri) => {
    await executeCurrentTinkerpadFile(uri);
  });

  const diagnoseCodeLens = vscode.commands.registerCommand(DIAGNOSE_CODE_LENS_COMMAND, async () => {
    await diagnoseCurrentCodeLens();
  });

  const codeLensProvider = new TinkerpadCodeLensProvider();

  const terminalCloseListener = vscode.window.onDidCloseTerminal((terminal) => {
    if (terminal === activeExecutionTerminal) {
      activeExecutionTerminal = undefined;
    }
  });

  const codeLensRegistration = vscode.languages.registerCodeLensProvider(
    CODE_LENS_DOCUMENT_SELECTOR,
    codeLensProvider
  );

  const configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(`tinkerpad.${CODE_LENS_ENABLED_CONFIG}`)) {
      codeLensProvider.refresh();
    }
  });

  const activeEditorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    warnIfEditorCodeLensIsDisabled(editor);
    codeLensProvider.refresh();
  });

  const documentOpenListener = vscode.workspace.onDidOpenTextDocument(() => {
    codeLensProvider.refresh();
  });

  setTimeout(() => codeLensProvider.refresh(), 0);
  warnIfEditorCodeLensIsDisabled(vscode.window.activeTextEditor);

  context.subscriptions.push(
    runNormal,
    diagnoseCodeLens,
    terminalCloseListener,
    codeLensProvider,
    codeLensRegistration,
    configurationListener,
    activeEditorListener,
    documentOpenListener
  );
}

export function deactivate(): void {
  activeExecutionTerminal = undefined;
}

async function executeCurrentTinkerpadFile(uri?: vscode.Uri): Promise<void> {
  const document = await getTargetDocument(uri);

  if (!document) {
    vscode.window.showErrorMessage('No active editor found. Open a .php file inside .tinkerpad.');
    return;
  }

  await executeTinkerpadDocument(document);
}

async function executeTinkerpadDocument(
  document: TinkerpadDocument,
  services: TinkerpadExecutionServices = defaultExecutionServices
): Promise<void> {
  if (!isRunnableTinkerpadFile(document)) {
    services.showErrorMessage('The active file must be a .php file inside a .tinkerpad folder.');
    return;
  }

  const workspaceFolder = services.getWorkspaceFolder(document.uri);

  if (!workspaceFolder) {
    services.showErrorMessage('Could not determine a workspace folder for the current file.');
    return;
  }

  const rawContent = document.getText();
  const contentWithoutPhpOpenTag = stripLeadingPhpOpenTag(rawContent);

  if (!contentWithoutPhpOpenTag.trim()) {
    services.showWarningMessage('The current .tinkerpad file is empty after removing the opening <?php tag.');
    return;
  }

  if (!await document.save()) {
    services.showErrorMessage('Could not save the current .tinkerpad file before running it.');
    return;
  }

  const config = await services.getConfig(workspaceFolder);

  if (!config) {
    return;
  }

  const artisanCommand = buildTinkerCommand(config);
  const runnableFilePath = getWorkspaceRelativePath(workspaceFolder, document);
  const terminal = createFreshExecutionTerminal(workspaceFolder.uri.fsPath, services.createTerminal);

  terminal.show(false);
  terminal.sendText(buildTinkerStartCommand(artisanCommand), true);
  terminal.sendText(buildTinkerRequireCommand(runnableFilePath), true);
}

const defaultExecutionServices: TinkerpadExecutionServices = {
  getWorkspaceFolder: (uri) => vscode.workspace.getWorkspaceFolder(uri),
  getConfig: getTinkerpadConfig,
  createTerminal: (cwd) => vscode.window.createTerminal({
    name: TERMINAL_NAME,
    cwd
  }),
  showErrorMessage: (message) => {
    void vscode.window.showErrorMessage(message);
  },
  showWarningMessage: (message) => {
    void vscode.window.showWarningMessage(message);
  }
};

async function getTargetDocument(uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  if (uri) {
    return vscode.workspace.openTextDocument(uri);
  }

  return vscode.window.activeTextEditor?.document;
}

function createFreshExecutionTerminal(
  cwd: string,
  createTerminal: TinkerpadExecutionServices['createTerminal'] = defaultExecutionServices.createTerminal
): TinkerpadTerminal {
  if (activeExecutionTerminal) {
    activeExecutionTerminal.dispose();
    activeExecutionTerminal = undefined;
  }

  activeExecutionTerminal = createTerminal(cwd);

  return activeExecutionTerminal;
}

function isRunnableTinkerpadFile(document: Pick<vscode.TextDocument, 'languageId' | 'fileName' | 'uri'>): boolean {
  if (document.languageId !== 'php' && !document.fileName.toLowerCase().endsWith('.php')) {
    return false;
  }

  const normalizedPath = document.uri.fsPath.replace(/\\/g, '/');
  return /\/\.tinkerpad\//.test(normalizedPath);
}

function stripLeadingPhpOpenTag(content: string): string {
  return content.replace(/^\uFEFF?\s*<\?php\b\s*/, '');
}

function getWorkspaceRelativePath(workspaceFolder: TinkerpadWorkspaceFolder, document: Pick<vscode.TextDocument, 'uri'>): string {
  return path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath).replace(/\\/g, '/');
}

function buildTinkerStartCommand(artisanCommand: string): string {
  return `clear; ${artisanCommand}`;
}

function buildTinkerRequireCommand(runnableFilePath: string): string {
  return `require base_path(${quoteForPhpString(runnableFilePath)});`;
}

function quoteForPhpString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function getTinkerpadConfig(workspaceFolder: TinkerpadWorkspaceFolder): Promise<TinkerpadConfig | undefined> {
  const configUri = vscode.Uri.joinPath(workspaceFolder.uri, CONFIG_DIRECTORY, CONFIG_FILE);

  try {
    const configBytes = await vscode.workspace.fs.readFile(configUri);
    const configContent = Buffer.from(configBytes).toString('utf8');
    const config = JSON.parse(configContent) as { command?: unknown; verbose?: unknown };
    const command = config.command ?? DEFAULT_TINKER_COMMAND;
    const verbose = config.verbose ?? DEFAULT_VERBOSE;

    if (typeof command !== 'string' || !command.trim()) {
      vscode.window.showErrorMessage('The .tinkerpad/config.json "command" value must be a non-empty string.');
      return undefined;
    }

    if (typeof verbose !== 'boolean') {
      vscode.window.showErrorMessage('The .tinkerpad/config.json "verbose" value must be a boolean.');
      return undefined;
    }

    return {
      command: command.trim(),
      verbose
    };
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
      return {
        command: DEFAULT_TINKER_COMMAND,
        verbose: DEFAULT_VERBOSE
      };
    }

    if (error instanceof SyntaxError) {
      vscode.window.showErrorMessage('Could not parse .tinkerpad/config.json. Make sure it contains valid JSON.');
      return undefined;
    }

    vscode.window.showErrorMessage('Could not read .tinkerpad/config.json.');
    return undefined;
  }
}

function buildTinkerCommand(config: TinkerpadConfig): string {
  if (!config.verbose) {
    return config.command;
  }

  return `${config.command} -vvv`;
}

class TinkerpadCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  refresh(): void {
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isCodeLensEnabled()) {
      return [];
    }

    if (!isRunnableTinkerpadFile(document)) {
      return [];
    }

    const topOfFile = document.lineAt(0).range;

    return [
      new vscode.CodeLens(topOfFile, {
        title: 'Run Tinkerpad',
        command: RUN_COMMAND,
        arguments: [document.uri]
      })
    ];
  }
}

function isCodeLensEnabled(): boolean {
  return vscode.workspace.getConfiguration('tinkerpad').get<boolean>(CODE_LENS_ENABLED_CONFIG, true);
}

function isEditorCodeLensEnabled(document: vscode.TextDocument): boolean {
  return vscode.workspace.getConfiguration('editor', document.uri).get<boolean>('codeLens', true);
}

function warnIfEditorCodeLensIsDisabled(editor: vscode.TextEditor | undefined): void {
  const document = editor?.document;

  if (!document || warnedAboutDisabledEditorCodeLens || !isCodeLensEnabled() || !isRunnableTinkerpadFile(document)) {
    return;
  }

  if (isEditorCodeLensEnabled(document)) {
    return;
  }

  warnedAboutDisabledEditorCodeLens = true;
  vscode.window
    .showWarningMessage(
      'VS Code CodeLens is disabled. Enable "Editor: Code Lens" to show Run Tinkerpad above .tinkerpad PHP files.',
      OPEN_SETTINGS_ACTION
    )
    .then((action) => {
      if (action === OPEN_SETTINGS_ACTION) {
        vscode.commands.executeCommand('workbench.action.openSettings', 'editor.codeLens');
      }
    });
}

async function diagnoseCurrentCodeLens(): Promise<void> {
  const document = vscode.window.activeTextEditor?.document;
  const output = vscode.window.createOutputChannel('Tinkerpad Diagnostics');

  output.clear();
  output.appendLine('Tinkerpad CodeLens diagnostics');
  output.appendLine('================================');

  if (!document) {
    output.appendLine('No active editor found.');
    output.show(true);
    vscode.window.showWarningMessage('No active editor found for Tinkerpad CodeLens diagnostics.');
    return;
  }

  output.appendLine(`uri: ${document.uri.toString(true)}`);
  output.appendLine(`scheme: ${document.uri.scheme}`);
  output.appendLine(`fileName: ${document.fileName}`);
  output.appendLine(`languageId: ${document.languageId}`);
  output.appendLine(`isUntitled: ${document.isUntitled}`);
  output.appendLine(`workspaceFolder: ${vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString(true) ?? '(none)'}`);
  output.appendLine(`selectorMatchScore: ${vscode.languages.match(CODE_LENS_DOCUMENT_SELECTOR, document)}`);
  output.appendLine(`isRunnableTinkerpadFile: ${isRunnableTinkerpadFile(document)}`);
  output.appendLine(`tinkerpad.codeLens.enabled: ${isCodeLensEnabled()}`);
  output.appendLine(`editor.codeLens: ${isEditorCodeLensEnabled(document)}`);

  try {
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      document.uri
    );
    const allLenses = lenses ?? [];
    const tinkerpadLenses = allLenses.filter((lens) => lens.command?.command === RUN_COMMAND);

    output.appendLine(`executeCodeLensProvider total: ${allLenses.length}`);
    output.appendLine(`executeCodeLensProvider tinkerpad: ${tinkerpadLenses.length}`);

    for (const lens of tinkerpadLenses) {
      output.appendLine(`tinkerpadLens: ${lens.command?.title ?? '(no title)'} at line ${lens.range.start.line + 1}`);
    }
  } catch (error) {
    output.appendLine(`executeCodeLensProvider error: ${error instanceof Error ? error.message : String(error)}`);
  }

  output.show(true);
  vscode.window.showInformationMessage('Tinkerpad CodeLens diagnostics written to the Tinkerpad Diagnostics output.');
}

export const __test = {
  buildTinkerCommand,
  buildTinkerRequireCommand,
  buildTinkerStartCommand,
  createFreshExecutionTerminal,
  executeTinkerpadDocument,
  getWorkspaceRelativePath,
  isRunnableTinkerpadFile,
  quoteForPhpString,
  resetState: () => {
    activeExecutionTerminal = undefined;
    warnedAboutDisabledEditorCodeLens = false;
  },
  stripLeadingPhpOpenTag
};
