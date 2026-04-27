# Tinkerpad Runner

VS Code extension to execute the current `.php` file from a `.tinkerpad` folder using Laravel Artisan Tinker.

## Commands

- **Tinkerpad: Run Current File**
  - Runs with `php artisan tinker`
- **Run Tinkerpad** CodeLens
  - Appears at the top of `.php` files inside `.tinkerpad`

## Configuration

Create `.tinkerpad/config.json` in your workspace to customize the local command used to start Tinker and enable verbose mode:

```json
{
  "mode": "local",
  "localCommand": "./vendor/bin/sail artisan tinker",
  "verbose": false
}
```

To run Tinker inside a Kubernetes container, set `mode` to `kubernetes`:

```json
{
  "mode": "kubernetes",
  "kubernetesCommand": "php artisan tinker",
  "verbose": false,
  "kubernetes": {
    "context": "",
    "namespace": "apps-prod",
    "podNamePrefix": "backend-",
    "container": "php-fpm",
    "remoteTempDirectory": "/tmp"
  }
}
```

If the file, `localCommand`, or `kubernetesCommand` value is missing, Tinkerpad uses `php artisan tinker`.
If `mode` is missing, Tinkerpad uses `local`.
If `mode` is `null`, Tinkerpad asks whether to run locally or in Kubernetes.
If `verbose` is missing, Tinkerpad uses `false`.
Legacy `command` configs are still accepted as a fallback for both commands.
Kubernetes mode assumes `kubectl` is installed and already authenticated for the configured context.

You can also disable the editor CodeLens from VS Code settings:

```json
{
  "tinkerpad.codeLens.enabled": false
}
```

## Behavior

- Only runs when the active file is a `.php` file inside a `.tinkerpad` directory.
- Shows `Run Tinkerpad` at the top of runnable files when `tinkerpad.codeLens.enabled` is enabled.
- Closes the previous Tinkerpad terminal before each run.
- Saves and executes the current `.tinkerpad` file by path, so the file code is not printed in the terminal.
- Starts an interactive Tinker session, runs the current file inside it, and keeps that same session open.
- Reads `.tinkerpad/config.json` to customize local/Kubernetes Tinker commands and verbose mode.
- In Kubernetes mode, uploads the current file to a temporary file in the container, requires it inside Tinker, and keeps the remote Tinker session open.
