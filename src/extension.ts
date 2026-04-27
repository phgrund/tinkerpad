import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';

let activeExecutionTerminal: TinkerpadTerminal | undefined;
let warnedAboutDisabledEditorCodeLens = false;
let diagnosticsOutputChannel: vscode.OutputChannel | undefined;

const RUN_COMMAND = 'tinkerpad.runCurrentFile';
const DIAGNOSE_CODE_LENS_COMMAND = 'tinkerpad.diagnoseCodeLens';
const TERMINAL_NAME = 'Tinkerpad';
const DEFAULT_TINKER_COMMAND = 'php artisan tinker';
const LEGACY_COMMAND_CONFIG_KEY = 'command';
const DEFAULT_VERBOSE = false;
const CONFIG_DIRECTORY = '.tinkerpad';
const CONFIG_FILE = 'config.json';
const CODE_LENS_ENABLED_CONFIG = 'codeLens.enabled';
const OPEN_SETTINGS_ACTION = 'Open Settings';
const CODE_LENS_DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { language: 'php' },
  { pattern: '**/*.php' }
];

type TinkerpadMode = 'local' | 'kubernetes';

type KubernetesConfig = {
  context: string;
  namespace: string;
  podNamePrefix: string;
  container: string;
  remoteTempDirectory: string;
};

type TinkerpadConfig = {
  mode: TinkerpadMode;
  localCommand: string;
  kubernetesCommand: string;
  verbose: boolean;
  kubernetes?: KubernetesConfig;
};

type TinkerpadTerminal = Pick<vscode.Terminal, 'show' | 'sendText' | 'dispose'>;

type TinkerpadDocument = Pick<vscode.TextDocument, 'uri' | 'fileName' | 'languageId' | 'getText' | 'save'>;

type TinkerpadWorkspaceFolder = Pick<vscode.WorkspaceFolder, 'uri'>;

type ProcessExecutionResult = {
  stderr: string;
  stdout: string;
};

type ProcessExecutionOptions = {
  input?: string;
};

type ConfigErrorReporter = (message: string) => void;
type ModePrompt = () => Promise<TinkerpadMode | undefined>;

type TinkerpadExecutionServices = {
  getWorkspaceFolder(uri: vscode.Uri): TinkerpadWorkspaceFolder | undefined;
  getConfig(workspaceFolder: TinkerpadWorkspaceFolder): Promise<TinkerpadConfig | undefined>;
  createTerminal(cwd: string): TinkerpadTerminal;
  getCurrentTimestamp(): number;
  runProcess(command: string, args: string[], options?: ProcessExecutionOptions): Promise<ProcessExecutionResult>;
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

    if (event.affectsConfiguration('editor.codeLens')) {
      warnedAboutDisabledEditorCodeLens = false;
      warnIfEditorCodeLensIsDisabled(vscode.window.activeTextEditor);
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
  diagnosticsOutputChannel?.dispose();
  diagnosticsOutputChannel = undefined;
}

function getDiagnosticsOutputChannel(): vscode.OutputChannel {
  if (!diagnosticsOutputChannel) {
    diagnosticsOutputChannel = vscode.window.createOutputChannel('Tinkerpad Diagnostics');
  }

  return diagnosticsOutputChannel;
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

  if (config.mode === 'kubernetes') {
    await executeKubernetesTinkerpadDocument(rawContent, artisanCommand, config, workspaceFolder, services);
    return;
  }

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
  getCurrentTimestamp: () => Date.now(),
  runProcess,
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

function buildDirectRequireCommand(filePath: string): string {
  return `require ${quoteForPhpString(filePath)};`;
}

function quoteForPhpString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function getTinkerpadConfig(workspaceFolder: TinkerpadWorkspaceFolder): Promise<TinkerpadConfig | undefined> {
  const configUri = vscode.Uri.joinPath(workspaceFolder.uri, CONFIG_DIRECTORY, CONFIG_FILE);

  try {
    const configBytes = await vscode.workspace.fs.readFile(configUri);
    const configContent = Buffer.from(configBytes).toString('utf8');
    const config = await resolvePromptedTinkerpadMode(JSON.parse(configContent) as Record<string, unknown>);

    return config ? parseTinkerpadConfig(config) : undefined;
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
      return {
        mode: 'local',
        localCommand: DEFAULT_TINKER_COMMAND,
        kubernetesCommand: DEFAULT_TINKER_COMMAND,
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

async function promptForTinkerpadMode(): Promise<TinkerpadMode | undefined> {
  const mode = await vscode.window.showQuickPick(['local', 'kubernetes'], {
    placeHolder: 'Where should Tinkerpad run this file?'
  });

  if (mode !== 'local' && mode !== 'kubernetes') {
    return undefined;
  }

  return mode;
}

async function resolvePromptedTinkerpadMode(
  config: Record<string, unknown>,
  prompt: ModePrompt = promptForTinkerpadMode
): Promise<Record<string, unknown> | undefined> {
  if (config.mode !== null) {
    return config;
  }

  const mode = await prompt();

  if (!mode) {
    return undefined;
  }

  return { ...config, mode };
}

function parseTinkerpadConfig(
  config: Record<string, unknown>,
  showErrorMessage: ConfigErrorReporter = showConfigErrorMessage
): TinkerpadConfig | undefined {
  const mode = config.mode === undefined ? 'local' : config.mode;
  const legacyCommand = config[LEGACY_COMMAND_CONFIG_KEY];
  const localCommand = config.localCommand ?? legacyCommand ?? DEFAULT_TINKER_COMMAND;
  const kubernetesCommand = config.kubernetesCommand ?? legacyCommand ?? DEFAULT_TINKER_COMMAND;
  const verbose = config.verbose ?? DEFAULT_VERBOSE;

  if (mode !== 'local' && mode !== 'kubernetes') {
    showErrorMessage('The .tinkerpad/config.json "mode" value must be either "local" or "kubernetes".');
    return undefined;
  }

  if (legacyCommand !== undefined && (typeof legacyCommand !== 'string' || !legacyCommand.trim())) {
    showErrorMessage('The .tinkerpad/config.json "command" value must be a non-empty string.');
    return undefined;
  }

  if (typeof localCommand !== 'string' || !localCommand.trim()) {
    showErrorMessage('The .tinkerpad/config.json "localCommand" value must be a non-empty string.');
    return undefined;
  }

  if (typeof kubernetesCommand !== 'string' || !kubernetesCommand.trim()) {
    showErrorMessage('The .tinkerpad/config.json "kubernetesCommand" value must be a non-empty string.');
    return undefined;
  }

  if (typeof verbose !== 'boolean') {
    showErrorMessage('The .tinkerpad/config.json "verbose" value must be a boolean.');
    return undefined;
  }

  if (mode === 'local') {
    return {
      mode,
      localCommand: localCommand.trim(),
      kubernetesCommand: kubernetesCommand.trim(),
      verbose
    };
  }

  const kubernetes = parseKubernetesConfig(config.kubernetes, showErrorMessage);

  if (!kubernetes) {
    return undefined;
  }

  return {
    mode,
    localCommand: localCommand.trim(),
    kubernetesCommand: kubernetesCommand.trim(),
    verbose,
    kubernetes
  };
}

function parseKubernetesConfig(config: unknown, showErrorMessage: ConfigErrorReporter): KubernetesConfig | undefined {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    showErrorMessage('The .tinkerpad/config.json "kubernetes" value must be an object.');
    return undefined;
  }

  const rawConfig = config as Record<string, unknown>;
  const context = readRequiredString(rawConfig, 'kubernetes.context', showErrorMessage);
  const namespace = readRequiredString(rawConfig, 'kubernetes.namespace', showErrorMessage);
  const podNamePrefix = readRequiredString(rawConfig, 'kubernetes.podNamePrefix', showErrorMessage);
  const container = readRequiredString(rawConfig, 'kubernetes.container', showErrorMessage);
  const remoteTempDirectory = readRequiredString(rawConfig, 'kubernetes.remoteTempDirectory', showErrorMessage);

  if (!context || !namespace || !podNamePrefix || !container || !remoteTempDirectory) {
    return undefined;
  }

  return {
    context,
    namespace,
    podNamePrefix,
    container,
    remoteTempDirectory: trimTrailingSlashes(remoteTempDirectory)
  };
}

function readRequiredString(
  config: Record<string, unknown>,
  dottedKey: string,
  showErrorMessage: ConfigErrorReporter
): string | undefined {
  const key = dottedKey.split('.').at(-1);
  const value = key ? config[key] : undefined;

  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  showErrorMessage(`The .tinkerpad/config.json "${dottedKey}" value must be a non-empty string.`);
  return undefined;
}

function showConfigErrorMessage(message: string): void {
  void vscode.window.showErrorMessage(message);
}

function trimTrailingSlashes(value: string): string {
  const trimmed = value.replace(/\/+$/, '');

  return trimmed || '/';
}

function buildTinkerCommand(config: TinkerpadConfig): string {
  const command = config.mode === 'kubernetes' ? config.kubernetesCommand : config.localCommand;

  if (!config.verbose) {
    return command;
  }

  return `${command} -vvv`;
}

async function executeKubernetesTinkerpadDocument(
  rawContent: string,
  artisanCommand: string,
  config: TinkerpadConfig,
  workspaceFolder: TinkerpadWorkspaceFolder,
  services: TinkerpadExecutionServices
): Promise<void> {
  if (!config.kubernetes) {
    services.showErrorMessage('The .tinkerpad/config.json "kubernetes" value is required when "mode" is "kubernetes".');
    return;
  }

  try {
    const pod = await findKubernetesPod(config.kubernetes, services.runProcess);

    if (!pod) {
      services.showErrorMessage(
        `No pod starting with "${config.kubernetes.podNamePrefix}" found in namespace "${config.kubernetes.namespace}".`
      );
      return;
    }

    const remoteFilePath = buildRemoteTempFilePath(config.kubernetes.remoteTempDirectory, services.getCurrentTimestamp());

    await uploadKubernetesTinkerpadFile(config.kubernetes, pod, remoteFilePath, rawContent, services.runProcess);

    const terminal = createFreshExecutionTerminal(workspaceFolder.uri.fsPath, services.createTerminal);

    terminal.show(false);
    terminal.sendText(buildTinkerStartCommand(buildKubernetesTinkerCommand(config.kubernetes, pod, artisanCommand)), true);
    terminal.sendText(buildDirectRequireCommand(remoteFilePath), true);
  } catch (error) {
    services.showErrorMessage(`Could not run Tinkerpad in Kubernetes: ${getErrorMessage(error)}`);
  }
}

async function findKubernetesPod(
  config: KubernetesConfig,
  runProcess: TinkerpadExecutionServices['runProcess']
): Promise<string | undefined> {
  const result = await runProcess('kubectl', buildKubernetesGetPodsArgs(config));
  const podPrefix = `pod/${config.podNamePrefix}`;
  const podLine = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith(podPrefix));

  return podLine?.replace(/^pod\//, '');
}

async function uploadKubernetesTinkerpadFile(
  config: KubernetesConfig,
  pod: string,
  remoteFilePath: string,
  content: string,
  runProcess: TinkerpadExecutionServices['runProcess']
): Promise<void> {
  await runProcess('kubectl', buildKubernetesUploadArgs(config, pod, remoteFilePath), {
    input: content
  });
}

function buildRemoteTempFilePath(remoteTempDirectory: string, timestamp: number): string {
  return path.posix.join(remoteTempDirectory, `tinkerpad-${timestamp}.php`);
}

function buildKubernetesGetPodsArgs(config: KubernetesConfig): string[] {
  return [
    '--context',
    config.context,
    '-n',
    config.namespace,
    'get',
    'pods',
    '-o',
    'name'
  ];
}

function buildKubernetesUploadArgs(config: KubernetesConfig, pod: string, remoteFilePath: string): string[] {
  return [
    '--context',
    config.context,
    '-n',
    config.namespace,
    'exec',
    '-i',
    pod,
    '-c',
    config.container,
    '--',
    'sh',
    '-c',
    `cat > ${quoteForShell(remoteFilePath)}`
  ];
}

function buildKubernetesTinkerCommand(config: KubernetesConfig, pod: string, artisanCommand: string): string {
  return [
    'kubectl',
    '--context',
    quoteForShell(config.context),
    '-n',
    quoteForShell(config.namespace),
    'exec',
    '-it',
    quoteForShell(pod),
    '-c',
    quoteForShell(config.container),
    '--',
    artisanCommand
  ].join(' ');
}

function runProcess(
  command: string,
  args: string[],
  options: ProcessExecutionOptions = {}
): Promise<ProcessExecutionResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || `${command} exited with code ${code ?? 'unknown'}.`));
    });

    child.stdin.end(options.input ?? '');
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
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
  void promptToEnableEditorCodeLens();
}

async function promptToEnableEditorCodeLens(): Promise<void> {
  const action = await vscode.window.showWarningMessage(
    'VS Code CodeLens is disabled. Enable "Editor: Code Lens" to show Run Tinkerpad above .tinkerpad PHP files.',
    OPEN_SETTINGS_ACTION
  );

  if (action === OPEN_SETTINGS_ACTION) {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'editor.codeLens');
  }
}

async function diagnoseCurrentCodeLens(): Promise<void> {
  const document = vscode.window.activeTextEditor?.document;
  const output = getDiagnosticsOutputChannel();

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
  buildDirectRequireCommand,
  buildKubernetesGetPodsArgs,
  buildKubernetesTinkerCommand,
  buildKubernetesUploadArgs,
  buildRemoteTempFilePath,
  buildTinkerCommand,
  buildTinkerRequireCommand,
  buildTinkerStartCommand,
  createFreshExecutionTerminal,
  executeTinkerpadDocument,
  getWorkspaceRelativePath,
  isRunnableTinkerpadFile,
  parseTinkerpadConfig,
  quoteForPhpString,
  resolvePromptedTinkerpadMode,
  resetState: () => {
    activeExecutionTerminal = undefined;
    warnedAboutDisabledEditorCodeLens = false;
  },
  stripLeadingPhpOpenTag
};
