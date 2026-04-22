import * as vscode from 'vscode';
import * as path from 'path';

let activeExecutionTerminal: vscode.Terminal | undefined;

const RUN_COMMAND = 'tinkerpad.runCurrentFile';
const TERMINAL_NAME = 'Tinkerpad';
const DEFAULT_TINKER_COMMAND = 'php artisan tinker';
const DEFAULT_VERBOSE = false;
const CONFIG_DIRECTORY = '.tinkerpad';
const CONFIG_FILE = 'config.json';

type TinkerpadConfig = {
  command: string;
  verbose: boolean;
};

export function activate(context: vscode.ExtensionContext): void {
  const runNormal = vscode.commands.registerCommand(RUN_COMMAND, async (uri?: vscode.Uri) => {
    await executeCurrentTinkerpadFile(uri);
  });

  const terminalCloseListener = vscode.window.onDidCloseTerminal((terminal) => {
    if (terminal === activeExecutionTerminal) {
      activeExecutionTerminal = undefined;
    }
  });

  const codeLensProvider = vscode.languages.registerCodeLensProvider(
    { language: 'php', scheme: 'file' },
    new TinkerpadCodeLensProvider()
  );

  context.subscriptions.push(runNormal, terminalCloseListener, codeLensProvider);
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

  if (!isRunnableTinkerpadFile(document)) {
    vscode.window.showErrorMessage('The active file must be a .php file inside a .tinkerpad folder.');
    return;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

  if (!workspaceFolder) {
    vscode.window.showErrorMessage('Could not determine a workspace folder for the current file.');
    return;
  }

  const rawContent = document.getText();
  const contentWithoutPhpOpenTag = stripLeadingPhpOpenTag(rawContent);

  if (!contentWithoutPhpOpenTag.trim()) {
    vscode.window.showWarningMessage('The current .tinkerpad file is empty after removing the opening <?php tag.');
    return;
  }

  if (!await document.save()) {
    vscode.window.showErrorMessage('Could not save the current .tinkerpad file before running it.');
    return;
  }

  const config = await getTinkerpadConfig(workspaceFolder);

  if (!config) {
    return;
  }

  const artisanCommand = buildTinkerCommand(config);
  const runnableFilePath = getWorkspaceRelativePath(workspaceFolder, document);
  const terminal = createFreshExecutionTerminal(workspaceFolder.uri.fsPath);

  terminal.show(false);
  terminal.sendText(buildHiddenExecutionCommand(artisanCommand, runnableFilePath), true);
}

async function getTargetDocument(uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  if (uri) {
    return vscode.workspace.openTextDocument(uri);
  }

  return vscode.window.activeTextEditor?.document;
}

function createFreshExecutionTerminal(cwd: string): vscode.Terminal {
  if (activeExecutionTerminal) {
    activeExecutionTerminal.dispose();
    activeExecutionTerminal = undefined;
  }

  activeExecutionTerminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    cwd
  });

  return activeExecutionTerminal;
}

function isRunnableTinkerpadFile(document: vscode.TextDocument): boolean {
  if (document.languageId !== 'php' && !document.fileName.toLowerCase().endsWith('.php')) {
    return false;
  }

  const normalizedPath = document.uri.fsPath.replace(/\\/g, '/');
  return /\/\.tinkerpad\//.test(normalizedPath);
}

function stripLeadingPhpOpenTag(content: string): string {
  return content.replace(/^\uFEFF?\s*<\?php\b\s*/, '');
}

function getWorkspaceRelativePath(workspaceFolder: vscode.WorkspaceFolder, document: vscode.TextDocument): string {
  return path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath).replace(/\\/g, '/');
}

function buildHiddenExecutionCommand(artisanCommand: string, runnableFilePath: string): string {
  const phpStatement = `require base_path(${JSON.stringify(runnableFilePath)});`;
  const executeCommand = `${artisanCommand} --execute=${quoteForShell(phpStatement)}`;

  return `clear; ${executeCommand}; ${artisanCommand}`;
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function getTinkerpadConfig(workspaceFolder: vscode.WorkspaceFolder): Promise<TinkerpadConfig | undefined> {
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

class TinkerpadCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isRunnableTinkerpadFile(document)) {
      return [];
    }

    const topOfFile = new vscode.Range(0, 0, 0, 0);

    return [
      new vscode.CodeLens(topOfFile, {
        title: 'Run Tinkerpad',
        command: RUN_COMMAND,
        arguments: [document.uri]
      })
    ];
  }
}
