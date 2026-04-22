# Tinkerpad Runner

VS Code extension to execute the current `.php` file from a `.tinkerpad` folder using Laravel Artisan Tinker.

## Commands

- **Tinkerpad: Run Current File**
  - Runs with `php artisan tinker`

## Configuration

Create `.tinkerpad/config.json` in your workspace to customize the command used to start Tinker and enable verbose mode:

```json
{
  "command": "./vendor/bin/sail artisan tinker",
  "verbose": false
}
```

If the file or `command` value is missing, Tinkerpad uses `php artisan tinker`.
If `verbose` is missing, Tinkerpad uses `false`.

## Behavior

- Only runs when the active file is a `.php` file inside a `.tinkerpad` directory.
- Shows `Run Tinkerpad` at the top of runnable files.
- Closes the previous Tinkerpad terminal before each run.
- Saves and executes the current `.tinkerpad` file by path, so the file code is not printed in the terminal.
- Starts a fresh Tinker session after the run, so you can continue typing in Tinker after the output appears.
- Reads `.tinkerpad/config.json` to customize the Tinker command and verbose mode.
