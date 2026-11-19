# Updating this fork safely

This fork is official T3 Code (`pingdotgg/t3code`) plus the new thread dashboard, on the
`ui/home-dashboard` branch. The app built from it, **T3 Code (Beta)**, never updates itself.
"Updating" means merging the official changes in, rebuilding, and reinstalling.

Your chats, settings, themes, keybindings and project scripts live in `~/.t3/userdata`, outside
this repository, so rebuilding or reinstalling never touches them. The one real risk is that a
newer build can upgrade the database so an older build can't read it. That's why you back up first.

## The quick way: `t3update`

Open Terminal or Ghostty (not a terminal inside T3) and run:

```sh
t3update
```

`t3update` is an alias in `~/.zshrc` for `~/Code/t3code/scripts/update-fork.sh`. It does every
step below in order and asks before anything you'd want a say in:

1. Merges the official changes, installs dependencies and runs the checks. If the only failure is
   the ChatView "rightPanelOpen" test, which also fails on the official version, it carries on;
   any other failure asks whether to continue.
2. Asks whether to try the build in a dev window first. Press Enter to skip.
3. Builds the app, which takes several minutes.
4. Asks to quit T3, pauses the background service, then backs up `~/.t3/userdata` to
   `~/.t3-backups/<date>`.
5. Installs the new app straight from the DMG, so there's nothing to drag. Then it reopens T3,
   updates the background service to the new version and pushes to your GitHub fork.
6. Deletes the oldest backups so only the two newest remain: the data from before this update and
   from before the previous one.

If you run it inside T3, it can't quit T3 without stopping itself. It stops after the build and
copies `~/Code/t3code/scripts/update-fork.sh install` to your clipboard. Quit T3 and paste that
into Terminal; `install` does only step 4 onward.

If the merge has conflicts, it stops and lists them. Fix them (see below), `git add` the files and
run `t3update` again; it finishes the merge and carries on. `t3update --help` lists the options,
such as `--skip-checks`, `--build-only` and `--no-push`. The script lives on `ui/home-dashboard`,
so run it with that branch checked out.

The rest of this guide is what the script does, in case you need to do a step by hand.

## Steps 1–3: safe while T3 is open

These don't touch your data.

```sh
# 1. Merge the official changes
cd ~/Code/t3code
git switch ui/home-dashboard
git fetch upstream && git merge upstream/main --no-edit
vp i

# 2. Test against a copy of your data, never the real ~/.t3
vp run check:changed
vp run migrate-dev-db --base-dir ~/Code/t3code/.t3
vp run dev --home-dir ~/Code/t3code/.t3   # open a new thread, check the dashboard, then Ctrl-C

# 3. Build the app
. "$HOME/.cargo/env"
vp run dist:desktop:dmg:arm64
```

`--no-edit` keeps Git's default merge message and skips the editor, so nothing you paste
afterwards ends up in the commit. If an editor does open, leave the text as it is and save and
close (vim: `:wq`, nano: Ctrl-O, Enter, Ctrl-X).

## Steps 4–7: quit T3 first

```sh
# 4. Quit T3 Code (Beta) completely, then pause the background service
launchctl bootout gui/$(id -u)/com.t3tools.t3code.service

# 5. Back up
mkdir -p ~/.t3-backups && cp -R ~/.t3/userdata ~/.t3-backups/$(date +%F)

# 6. Open release/T3-Code-*-arm64.dmg and drag "T3 Code (Beta)" into Applications, replacing the old one

# 7. Open T3, then update the background service to the new version and push the merge
~/.t3/bin/t3 service install
git -c credential.helper= -c credential.helper='!gh auth git-credential' push
```

**Why step 4 matters:** the background service (`com.t3tools.t3code.service`) starts its own
server on `~/.t3/userdata` as soon as the app quits. Left running, it writes to the database while
you copy it, and it runs whatever T3 version it was installed with, which can be older than the
new app. `t3 service install` in step 7 brings it back on the new version. Run it after T3 is
open so the app claims your data first. `t3 service status` shows whether it needs an update.

The backup is several GB. Keep it until the new build has worked for a few days; `t3update` keeps
the two newest and deletes older ones. Backups live in
`~/.t3-backups`, a hidden folder; in Finder, press Cmd-Shift-. to show hidden files. If macOS blocks
the new app, right-click it and choose **Open**.

## Rules that keep your data safe

- **Never run the Beta and the official Nightly at the same time.** They share `~/.t3`, and two
  running at once can corrupt the database. Opening the Nightly on its own is risky too: it
  updates itself, so it can upgrade your database past what your Beta can read.
- **Test against a copy, never against `~/.t3`.** Dev runs use `~/Code/t3code/.t3`.
- **Never `git init` or `git add` inside `~/.t3`.** It holds your database and secrets.

## If something goes wrong

**The merge has conflicts.** They usually land in `apps/web/src/components/ChatView.tsx` or
`apps/web/src/index.css`. Keep the official changes and re-apply the dashboard lines (search for
`showHomeDashboard` and `data-home-hero`). Or run `git merge --abort` and try again later.

**The push is rejected with "without `workflow` scope".** The merge changed a file in
`.github/workflows/`, and your `gh` login needs permission for that. Run this once, approve it in
the browser, then push again:

```sh
gh auth refresh -h github.com -s workflow
```

**The new build is broken.** Quit T3, pause the background service, then put the backup back:

```sh
launchctl bootout gui/$(id -u)/com.t3tools.t3code.service
mv ~/.t3/userdata ~/.t3/userdata-broken
cp -R ~/.t3-backups/YYYY-MM-DD ~/.t3/userdata
```

Then reinstall the previous DMG (older ones stay in `release/`), open T3 and run
`~/.t3/bin/t3 service install`. To drop a bad merge instead, run the `git reset --hard …` command
`t3update` printed after merging (or `git reset --hard ORIG_HEAD` right after a manual merge) and
rebuild. Delete `~/.t3/userdata-broken` once everything works.

## Going back to the official app

Install the latest official Nightly, at least as new as your last merge, so it can read your
database. Quit and delete T3 Code (Beta) first: both apps share the bundle ID `com.t3tools.t3code`.
