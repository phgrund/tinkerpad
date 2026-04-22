import * as vscode from 'vscode';

let activeExecutionTerminal: vscode.Terminal | undefined;

const RUN_COMMAND = 'tinkerpad.runCurrentFile';
const RUN_VERBOSE_COMMAND = 'tinkerpad.runCurrentFileVerbose';

export function activate(context: vscode.ExtensionContext): void {
  const runNormal = vscode.commands.registerCommand(RUN_COMMAND, async () => {
    await executeCurrentTinkerpadFile(false);
  });

  const runVerbose = vscode.commands.registerCommand(RUN_VERBOSE_COMMAND, async () => {
    await executeCurrentTinkerpadFile(true);
  });

  context.subscriptions.push(runNormal, runVerbose);
}

export function deactivate(): void {
  activeExecutionTerminal?.dispose();
  activeExecutionTerminal = undefined;
}

async function executeCurrentTinkerpadFile(verbose: boolean): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    vscode.window.showErrorMessage('No active editor found. Open a .php file inside .tinkerpad.');
    return;
  }

  const document = editor.document;

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

  if (activeExecutionTerminal) {
    activeExecutionTerminal.dispose();
    activeExecutionTerminal = undefined;
  }

  const terminalName = verbose ? 'Tinkerpad (verbose)' : 'Tinkerpad';
  activeExecutionTerminal = vscode.window.createTerminal({
    name: terminalName,
    cwd: workspaceFolder.uri.fsPath
  });

  const delimiter = '__TINKERPAD_INPUT__';
  const artisanCommand = verbose ? 'php artisan tinker -vvv' : 'php artisan tinker';
  const script = `${artisanCommand} <<'${delimiter}'\n${contentWithoutPhpOpenTag}\n${delimiter}`;

  activeExecutionTerminal.show(true);
  activeExecutionTerminal.sendText(script, true);
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
