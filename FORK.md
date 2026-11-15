# Updating this fork safely

This fork is upstream T3 Code (`pingdotgg/t3code`) plus the new thread dashboard on the
`ui/home-dashboard` branch. The app you build from it, **T3 Code (Beta)**, never updates itself.
To get upstream fixes you merge them in and rebuild. Your threads, settings, and themes live in
`~/.t3/userdata`, outside this repository, and the steps below keep them safe.

## Rules that protect your data

- **Run one T3 at a time.** The Beta, the official Nightly, and `vp run dev --home-dir ~/.t3` all
  share `~/.t3`. Two running together can corrupt the database.
- **Back up before every update.** A newer T3 can migrate the database, and an older build may
  not read it afterwards. The backup is your only way back.
- **Test against a copy, never against `~/.t3`.** Dev runs below use `~/Code/t3code/.t3`.
- **Never `git init` or `git add` inside `~/.t3`.** It holds your database and secrets.

## 1. Back up

Quit T3 Code first, so the database is not mid-write, then:

```sh
cp -R ~/.t3/userdata ~/t3-backup-$(date +%F)
```

This is about 1.5 GB. Keep it until the new build has worked for a few days.

## 2. Merge upstream

```sh
cd ~/Code/t3code
git switch ui/home-dashboard
git fetch upstream
git merge upstream/main
vp i
```

Conflicts usually land in `apps/web/src/components/ChatView.tsx` or `apps/web/src/index.css`.
Keep upstream's changes and re-apply the dashboard lines (search for `showHomeDashboard` and
`data-home-hero`). Run `git merge --abort` to back out and try again later.

## 3. Check it

```sh
vp run check:changed
vp run migrate-dev-db --base-dir ~/Code/t3code/.t3
vp run dev --home-dir ~/Code/t3code/.t3
```

`migrate-dev-db` copies your data read-only into the repo's own `.t3`. Open the pairing URL the
dev server prints, start a new thread, and check that the dashboard renders. Stop the server with
Ctrl-C.

## 4. Rebuild and install

```sh
. "$HOME/.cargo/env"
vp run dist:desktop:dmg:arm64
```

Quit T3 Code, open `release/T3-Code-*-arm64.dmg`, and drag **T3 Code (Beta)** into Applications,
replacing the old copy. If macOS blocks it, right-click it and choose **Open**.

Then save the merge to GitHub:

```sh
git -c credential.helper='!gh auth git-credential' push
```

## If something goes wrong

Quit T3 Code, then put the backup back:

```sh
mv ~/.t3/userdata ~/.t3/userdata-broken
cp -R ~/t3-backup-YYYY-MM-DD ~/.t3/userdata
```

Reinstall the previous DMG, or run `git reset --hard ORIG_HEAD` right after a bad merge and
rebuild. Delete `~/.t3/userdata-broken` once everything works.

## Going back to the official app

Install the latest official Nightly, at least as new as your last merge from upstream, so it can
read the migrated database. Quit and delete T3 Code (Beta) first: both apps share the bundle ID
`com.t3tools.t3code`.
