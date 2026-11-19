# Screenshot setups

Arrange your projects, sessions, presets and appearance in [`do-run-dev.bat`](../do-run-dev.bat), then **quit fat-g** and wait for its terminal to finish.

From Explorer, double-click **[`do-dev-screenshot-save.bat`](../do-dev-screenshot-save.bat)** once to freeze that setup, then **[`do-dev-screenshot-run.bat`](../do-dev-screenshot-run.bat)** for each take. No arguments needed. Run opens the window with `--window-size=1920x1080`, subject to the display's usable work area.

Freeze that starting point once:

```bat
do-dev-setup.bat save
```

Start each take with:

```bat
do-dev-setup.bat run
```

Close the setup's window between takes. Each run starts the current dev build with a fresh, separate copy; your everyday dev and installed data stay untouched. To keep changes made in the screenshot window, close it and use Save, choosing **Screenshot window**, before the next Run. Otherwise the next Run discards those changes.

The default name is `screenshots`. For several setups, add a name: `save overview`, then `run overview`. Once a screenshot working copy exists, Save asks which data to capture: **Screenshot window** (`do-dev-screenshot-run.bat`) or **Everyday dev** (`do-run-dev.bat`), with **Cancel** to keep the saved setup unchanged. If the snapshot already exists, that same dialog confirms replacing it from the selected source. Close the chosen window first. Before a screenshot working copy exists, Save captures everyday dev.

The copy includes projects, sessions, chats, presets, settings, plans, attachments and user media. It excludes logs, caches, project files and CLI configuration. Links and junctions are refused. The tool checks Electron's data-folder lock before copying.

This restores saved app data, so live questions, approvals and running statuses do not survive restart. The CLI's own conversation history and project files are not rewound. Sending a real prompt still uses your real account. For scripted activity and questions without CLI calls, use the existing [`do-run-stream.bat`](../do-run-stream.bat).

Setups live outside the repository, in `fat-g-dev-setups` beside the usual data folder (Windows: `%APPDATA%\fat-g-dev-setups`). `snapshots/<name>/` is the frozen copy; `runs/<name>/` is disposable. They contain the same private data as the original: delete these folders manually when finished. Removing a session in the app does not remove an older snapshot. Temporary `.saving-*` or `.restoring-*` folders can remain after a crash and may also be deleted with the tool closed. The current app's normal format checks still apply after code changes.

On macOS/Linux: `npm run dev:setup -- save` and `npm run dev:setup -- run`.
