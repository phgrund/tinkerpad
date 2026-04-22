import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import * as extension from '../extension';

type TestConfig = Parameters<typeof extension.__test.buildTinkerCommand>[0];
type TestDocument = Parameters<typeof extension.__test.executeTinkerpadDocument>[0];
type TestServices = NonNullable<Parameters<typeof extension.__test.executeTinkerpadDocument>[1]>;

const workspacePath = path.join(process.cwd(), 'test workspace');
const runnableRelativePath = '.tinkerpad/scratch.php';
const runnableFilePath = path.join(workspacePath, '.tinkerpad', 'scratch.php');

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

function createExecutionHarness(config: TestConfig = { command: 'php artisan tinker', verbose: false }): {
  errors: string[];
  services: TestServices;
  terminals: FakeTerminal[];
  warnings: string[];
} {
  const errors: string[] = [];
  const terminals: FakeTerminal[] = [];
  const warnings: string[] = [];

  return {
    errors,
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
      command: './vendor/bin/sail artisan tinker',
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
});
