import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import * as extension from '../extension';

type TestConfig = Parameters<typeof extension.__test.buildTinkerCommand>[0];
type TestDocument = Parameters<typeof extension.__test.executeTinkerpadDocument>[0];
type TestServices = NonNullable<Parameters<typeof extension.__test.executeTinkerpadDocument>[1]>;
type TestProcessCall = {
  args: string[];
  command: string;
  options?: Parameters<TestServices['runProcess']>[2];
};

const workspacePath = path.join(process.cwd(), 'test workspace');
const runnableRelativePath = '.tinkerpad/scratch.php';
const runnableFilePath = path.join(workspacePath, '.tinkerpad', 'scratch.php');
const defaultConfig: TestConfig = {
  mode: 'local',
  localCommand: 'php artisan tinker',
  kubernetesCommand: 'php artisan tinker',
  verbose: false
};
const kubernetesConfig: TestConfig = {
  mode: 'kubernetes',
  localCommand: 'php artisan tinker',
  kubernetesCommand: 'php artisan tinker',
  verbose: false,
  kubernetes: {
    context: 'arn:aws:eks:sa-east-1:050806348937:cluster/aptast-prod',
    namespace: 'apps-prod',
    podNamePrefix: 'backend-',
    container: 'php-fpm',
    remoteTempDirectory: '/tmp'
  }
};

class FakeTerminal {
  readonly sendTextCalls: Array<{ text: string; addNewLine: boolean | undefined }> = [];
  readonly showCalls: Array<boolean | undefined> = [];
  disposed = false;

  constructor(readonly cwd: string) {}

  show(preserveFocus?: boolean): void {
    this.showCalls.push(preserveFocus);
  }

  sendText(text: string, addNewLine?: boolean): void {
    this.sendTextCalls.push({ text, addNewLine });
  }

  dispose(): void {
    this.disposed = true;
  }
}

function createDocument(content: string, filePath = runnableFilePath): TestDocument {
  const uri = vscode.Uri.file(filePath);

  return {
    uri,
    fileName: filePath,
    languageId: 'php',
    getText: () => content,
    save: async () => true
  };
}

function createExecutionHarness(
  config: TestConfig = defaultConfig,
  processResults: Array<{ stderr: string; stdout: string }> = []
): {
  errors: string[];
  processCalls: TestProcessCall[];
  services: TestServices;
  terminals: FakeTerminal[];
  warnings: string[];
} {
  const errors: string[] = [];
  const processCalls: TestProcessCall[] = [];
  const terminals: FakeTerminal[] = [];
  const warnings: string[] = [];

  return {
    errors,
    processCalls,
    terminals,
    warnings,
    services: {
      getWorkspaceFolder: () => ({ uri: vscode.Uri.file(workspacePath) }),
      getConfig: async () => config,
      createTerminal: (cwd) => {
        const terminal = new FakeTerminal(cwd);

        terminals.push(terminal);
        return terminal;
      },
      getCurrentTimestamp: () => 1700000000000,
      runProcess: async (command, args, options) => {
        processCalls.push({ command, args, options });
        return processResults.shift() ?? { stderr: '', stdout: '' };
      },
      showErrorMessage: (message) => {
        errors.push(message);
      },
      showWarningMessage: (message) => {
        warnings.push(message);
      }
    }
  };
}

function assertDefaultRequireRun(terminal: FakeTerminal): void {
  assert.deepStrictEqual(terminal.sendTextCalls, [
    { text: 'clear; php artisan tinker', addNewLine: true },
    { text: `require base_path('${runnableRelativePath}');`, addNewLine: true }
  ]);
}

suite('Tinkerpad execution', () => {
  setup(() => {
    extension.__test.resetState();
  });

  teardown(() => {
    extension.__test.resetState();
  });

  test('does not write commented PHP code into the terminal', async () => {
    const harness = createExecutionHarness();
    const contentWithComments = `<?php
// require base_path('wrong.php');
# clear; exit
/*
 * A block comment can mention tinker commands, quotes, or PHP open tags:
 * <?php echo "this must not be sent directly";
 */
echo "safe";
`;

    await extension.__test.executeTinkerpadDocument(createDocument(contentWithComments), harness.services);

    assert.deepStrictEqual(harness.errors, []);
    assert.deepStrictEqual(harness.warnings, []);
    assert.strictEqual(harness.terminals.length, 1);
    assertDefaultRequireRun(harness.terminals[0]);
    assert.ok(!harness.terminals[0].sendTextCalls.some((call) => call.text.includes('wrong.php')));
    assert.ok(!harness.terminals[0].sendTextCalls.some((call) => call.text.includes('clear; exit')));
  });

  test('does not break with heredoc and nowdoc strings', async () => {
    const harness = createExecutionHarness();
    const contentWithDocStrings = `<?php
$query = <<<SQL
select "<?php", "require base_path('not-this.php')", "# not a comment";
SQL;

$template = <<<'BLADE'
@php echo "still only file content"; @endphp
BLADE;

dump($query, $template);
`;

    await extension.__test.executeTinkerpadDocument(createDocument(contentWithDocStrings), harness.services);

    assert.deepStrictEqual(harness.errors, []);
    assert.deepStrictEqual(harness.warnings, []);
    assert.strictEqual(harness.terminals.length, 1);
    assertDefaultRequireRun(harness.terminals[0]);
    assert.ok(!harness.terminals[0].sendTextCalls.some((call) => call.text.includes('not-this.php')));
  });

  test('keeps the terminal open after requiring the file in the same tinker context', async () => {
    const harness = createExecutionHarness({
      mode: 'local',
      localCommand: './vendor/bin/sail artisan tinker',
      kubernetesCommand: 'php artisan tinker',
      verbose: true
    });

    await extension.__test.executeTinkerpadDocument(createDocument('<?php echo "hello";'), harness.services);

    assert.strictEqual(harness.terminals.length, 1);

    const terminal = harness.terminals[0];

    assert.strictEqual(terminal.cwd, workspacePath);
    assert.strictEqual(terminal.disposed, false);
    assert.deepStrictEqual(terminal.showCalls, [false]);
    assert.deepStrictEqual(terminal.sendTextCalls, [
      { text: 'clear; ./vendor/bin/sail artisan tinker -vvv', addNewLine: true },
      { text: `require base_path('${runnableRelativePath}');`, addNewLine: true }
    ]);
  });

  test('disposes only the previous Tinkerpad terminal before a new run', async () => {
    const harness = createExecutionHarness();

    await extension.__test.executeTinkerpadDocument(createDocument('<?php echo "first";'), harness.services);
    await extension.__test.executeTinkerpadDocument(createDocument('<?php echo "second";'), harness.services);

    assert.strictEqual(harness.terminals.length, 2);
    assert.strictEqual(harness.terminals[0].disposed, true);
    assert.strictEqual(harness.terminals[1].disposed, false);
    assertDefaultRequireRun(harness.terminals[1]);
  });

  test('does not create a terminal for an empty file after the PHP opening tag', async () => {
    const harness = createExecutionHarness();

    await extension.__test.executeTinkerpadDocument(createDocument('<?php  '), harness.services);

    assert.deepStrictEqual(harness.errors, []);
    assert.deepStrictEqual(harness.warnings, [
      'The current .tinkerpad file is empty after removing the opening <?php tag.'
    ]);
    assert.deepStrictEqual(harness.terminals, []);
  });

  test('runs a tinkerpad file inside a kubernetes container using a temporary remote file', async () => {
    const harness = createExecutionHarness(kubernetesConfig, [
      { stderr: '', stdout: 'pod/backend-abc123\npod/worker-xyz\n' },
      { stderr: '', stdout: '' }
    ]);
    const content = `<?php
$name = "O'Hara";
dump($name);
`;

    await extension.__test.executeTinkerpadDocument(createDocument(content), harness.services);

    assert.deepStrictEqual(harness.errors, []);
    assert.deepStrictEqual(harness.warnings, []);
    assert.strictEqual(harness.terminals.length, 1);
    assert.deepStrictEqual(harness.processCalls, [
      {
        command: 'kubectl',
        args: [
          '--context',
          'arn:aws:eks:sa-east-1:050806348937:cluster/aptast-prod',
          '-n',
          'apps-prod',
          'get',
          'pods',
          '-o',
          'name'
        ],
        options: undefined
      },
      {
        command: 'kubectl',
        args: [
          '--context',
          'arn:aws:eks:sa-east-1:050806348937:cluster/aptast-prod',
          '-n',
          'apps-prod',
          'exec',
          '-i',
          'backend-abc123',
          '-c',
          'php-fpm',
          '--',
          'sh',
          '-c',
          "cat > '/tmp/tinkerpad-1700000000000.php'"
        ],
        options: { input: content }
      }
    ]);
    assert.deepStrictEqual(harness.terminals[0].sendTextCalls, [
      {
        text: "clear; kubectl --context 'arn:aws:eks:sa-east-1:050806348937:cluster/aptast-prod' -n 'apps-prod' exec -it 'backend-abc123' -c 'php-fpm' -- php artisan tinker",
        addNewLine: true
      },
      { text: "require '/tmp/tinkerpad-1700000000000.php';", addNewLine: true }
    ]);
  });

  test('does not run aws commands for kubernetes execution', async () => {
    const harness = createExecutionHarness(kubernetesConfig, [
      { stderr: '', stdout: 'pod/backend-abc123\n' },
      { stderr: '', stdout: '' }
    ]);

    await extension.__test.executeTinkerpadDocument(createDocument('<?php echo "hello";'), harness.services);

    assert.ok(harness.processCalls.every((call) => call.command === 'kubectl'));
    assert.ok(!harness.processCalls.some((call) => call.command === 'aws'));
    assert.ok(!harness.processCalls.some((call) => call.args.some((arg) => ['sts', 'sso', 'login'].includes(arg))));
  });
});

suite('Tinkerpad helpers', () => {
  test('recognizes only PHP files inside a .tinkerpad directory as runnable', () => {
    assert.strictEqual(extension.__test.isRunnableTinkerpadFile(createDocument('<?php echo "ok";')), true);
    assert.strictEqual(
      extension.__test.isRunnableTinkerpadFile(createDocument('<?php echo "no";', path.join(workspacePath, 'scratch.php'))),
      false
    );
    assert.strictEqual(
      extension.__test.isRunnableTinkerpadFile({
        ...createDocument('<?php echo "no";', path.join(workspacePath, '.tinkerpad', 'scratch.txt')),
        languageId: 'plaintext'
      }),
      false
    );
  });

  test('strips only the leading PHP opening tag', () => {
    assert.strictEqual(
      extension.__test.stripLeadingPhpOpenTag('\uFEFF  <?php echo "<?php stays";'),
      'echo "<?php stays";'
    );
  });

  test('quotes runnable paths for a PHP string', () => {
    assert.strictEqual(
      extension.__test.quoteForPhpString("dir\\nested\\john's file.php"),
      "'dir\\\\nested\\\\john\\'s file.php'"
    );
  });

  test('builds the tinker command from the active mode command', () => {
    assert.strictEqual(extension.__test.buildTinkerCommand({
      mode: 'local',
      localCommand: './vendor/bin/sail artisan tinker',
      kubernetesCommand: 'php artisan tinker',
      verbose: false
    }), './vendor/bin/sail artisan tinker');
    assert.strictEqual(extension.__test.buildTinkerCommand({
      mode: 'kubernetes',
      localCommand: './vendor/bin/sail artisan tinker',
      kubernetesCommand: 'php artisan tinker',
      verbose: true
    }), 'php artisan tinker -vvv');
  });

  test('parses legacy command as the default for both command modes', () => {
    assert.deepStrictEqual(extension.__test.parseTinkerpadConfig({
      command: './vendor/bin/sail artisan tinker'
    }), {
      mode: 'local',
      localCommand: './vendor/bin/sail artisan tinker',
      kubernetesCommand: './vendor/bin/sail artisan tinker',
      verbose: false
    });
  });

  test('resolves a null mode from a prompted choice', async () => {
    assert.deepStrictEqual(await extension.__test.resolvePromptedTinkerpadMode({
      mode: null,
      localCommand: './vendor/bin/sail artisan tinker'
    }, async () => 'kubernetes'), {
      mode: 'kubernetes',
      localCommand: './vendor/bin/sail artisan tinker'
    });
    assert.strictEqual(await extension.__test.resolvePromptedTinkerpadMode({
      mode: null
    }, async () => undefined), undefined);
  });

  test('validates invalid config values', () => {
    const invalidConfigs: Array<{ config: Record<string, unknown>; error: string }> = [
      {
        config: { mode: 'docker' },
        error: 'The .tinkerpad/config.json "mode" value must be either "local" or "kubernetes".'
      },
      {
        config: { mode: null },
        error: 'The .tinkerpad/config.json "mode" value must be either "local" or "kubernetes".'
      },
      {
        config: { localCommand: '' },
        error: 'The .tinkerpad/config.json "localCommand" value must be a non-empty string.'
      },
      {
        config: { kubernetesCommand: '' },
        error: 'The .tinkerpad/config.json "kubernetesCommand" value must be a non-empty string.'
      },
      {
        config: { verbose: 'yes' },
        error: 'The .tinkerpad/config.json "verbose" value must be a boolean.'
      },
      {
        config: { mode: 'kubernetes' },
        error: 'The .tinkerpad/config.json "kubernetes" value must be an object.'
      },
      {
        config: {
          mode: 'kubernetes',
          kubernetes: {
            namespace: 'apps-prod',
            podNamePrefix: 'backend-',
            container: 'php-fpm',
            remoteTempDirectory: '/tmp'
          }
        },
        error: 'The .tinkerpad/config.json "kubernetes.context" value must be a non-empty string.'
      },
      {
        config: {
          mode: 'kubernetes',
          kubernetes: {
            context: 'prod',
            podNamePrefix: 'backend-',
            container: 'php-fpm',
            remoteTempDirectory: '/tmp'
          }
        },
        error: 'The .tinkerpad/config.json "kubernetes.namespace" value must be a non-empty string.'
      },
      {
        config: {
          mode: 'kubernetes',
          kubernetes: {
            context: 'prod',
            namespace: 'apps-prod',
            container: 'php-fpm',
            remoteTempDirectory: '/tmp'
          }
        },
        error: 'The .tinkerpad/config.json "kubernetes.podNamePrefix" value must be a non-empty string.'
      },
      {
        config: {
          mode: 'kubernetes',
          kubernetes: {
            context: 'prod',
            namespace: 'apps-prod',
            podNamePrefix: 'backend-',
            remoteTempDirectory: '/tmp'
          }
        },
        error: 'The .tinkerpad/config.json "kubernetes.container" value must be a non-empty string.'
      },
      {
        config: {
          mode: 'kubernetes',
          kubernetes: {
            context: 'prod',
            namespace: 'apps-prod',
            podNamePrefix: 'backend-',
            container: 'php-fpm'
          }
        },
        error: 'The .tinkerpad/config.json "kubernetes.remoteTempDirectory" value must be a non-empty string.'
      }
    ];

    for (const invalidConfig of invalidConfigs) {
      const errors: string[] = [];

      assert.strictEqual(extension.__test.parseTinkerpadConfig(invalidConfig.config, (message) => {
        errors.push(message);
      }), undefined);
      assert.ok(errors.includes(invalidConfig.error));
    }
  });

  test('builds kubernetes helpers with shell and PHP escaping', () => {
    const config = {
      context: "ctx'prod",
      namespace: 'apps-prod',
      podNamePrefix: 'backend-',
      container: 'php-fpm',
      remoteTempDirectory: '/tmp'
    };

    assert.deepStrictEqual(extension.__test.buildKubernetesGetPodsArgs(config), [
      '--context',
      "ctx'prod",
      '-n',
      'apps-prod',
      'get',
      'pods',
      '-o',
      'name'
    ]);
    assert.deepStrictEqual(
      extension.__test.buildKubernetesUploadArgs(config, 'backend-1', "/tmp/tinkerpad-john's.php"),
      [
        '--context',
        "ctx'prod",
        '-n',
        'apps-prod',
        'exec',
        '-i',
        'backend-1',
        '-c',
        'php-fpm',
        '--',
        'sh',
        '-c',
        "cat > '/tmp/tinkerpad-john'\\''s.php'"
      ]
    );
    assert.strictEqual(
      extension.__test.buildKubernetesTinkerCommand(config, "backend-'1", 'php artisan tinker'),
      "kubectl --context 'ctx'\\''prod' -n 'apps-prod' exec -it 'backend-'\\''1' -c 'php-fpm' -- php artisan tinker"
    );
    assert.strictEqual(
      extension.__test.buildDirectRequireCommand("/tmp/tinkerpad-john's.php"),
      "require '/tmp/tinkerpad-john\\'s.php';"
    );
  });
});
