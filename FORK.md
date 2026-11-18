# Updating this fork safely

This fork is official T3 Code (`pingdotgg/t3code`) plus the new thread dashboard, on the
`ui/home-dashboard` branch. The app built from it, **T3 Code (Beta)**, never updates itself.
"Updating" means merging the official changes in, rebuilding, and reinstalling.

Your chats, settings, themes, keybindings and project scripts live in `~/.t3/userdata`, outside
this repository, so rebuilding or reinstalling never touches them. The one real risk is that a
newer build can upgrade the database so an older build can't read it. That's why you back up first.

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

## Steps 4–6: quit T3 first

```sh
# 4. Quit T3 Code (Beta) completely, then back up
cp -R ~/.t3/userdata ~/t3-backup-$(date +%F)

# 5. Open release/T3-Code-*-arm64.dmg and drag "T3 Code (Beta)" into Applications, replacing the old one

# 6. Push the merge to your GitHub fork
git -c credential.helper='!gh auth git-credential' push
```

The backup is several GB. Keep it until the new build has worked for a few days. If macOS blocks
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

**The new build is broken.** Quit T3, then put the backup back:

```sh
mv ~/.t3/userdata ~/.t3/userdata-broken
cp -R ~/t3-backup-YYYY-MM-DD ~/.t3/userdata
```

Then reinstall the previous DMG, or run `git reset --hard ORIG_HEAD` right after a bad merge and
rebuild. Delete `~/.t3/userdata-broken` once everything works.

## Going back to the official app

Install the latest official Nightly, at least as new as your last merge, so it can read your
database. Quit and delete T3 Code (Beta) first: both apps share the bundle ID `com.t3tools.t3code`.
