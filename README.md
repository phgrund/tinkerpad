# Tinkerpad Runner

VS Code extension to execute the current `.php` file from a `.tinkerpad` folder using Laravel Artisan Tinker.

## Commands

- **Tinkerpad: Run Current File**
  - Runs with `php artisan tinker`
- **Tinkerpad: Run Current File (Verbose -vvv)**
  - Runs with `php artisan tinker -vvv`

## Behavior

- Only runs when the active file is a `.php` file inside a `.tinkerpad` directory.
- Removes the leading `<?php` from the file before sending content to Tinker.
- Creates an interactive terminal for each execution and keeps it open.
- If you run again, the previous execution terminal is closed and a new one is created.
- Uses a quoted heredoc to preserve content as-is, supporting single quotes, double quotes, heredoc, and nowdoc syntax in the input file.
