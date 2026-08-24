# Server setup

This walks through installing Shipway on a fresh Ubuntu 24.04 server, from prerequisites to the first project going live.

## Prerequisites

Before running the installer, have these ready:

1. **A dedicated Ubuntu 24.04 LTS server**, root access (a fresh box works best; the installer is idempotent but is not meant to coexist with an unrelated nginx/PHP/MySQL setup).
2. **A domain managed at Cloudflare**, with a wildcard DNS record pointed at the server. Add an `A` record for `*.<your-base-domain>` (for example `*.intcore.dev`) pointing at the server's public IP. Shipway creates the two records it needs for itself (`deploy.<base-domain>` and `mail.<base-domain>`) automatically during install; the wildcard covers every project subdomain after that.
3. **A Cloudflare API token** scoped to that zone with `Zone:DNS:Edit` permission (Cloudflare dashboard: My Profile > API Tokens > Create Token > "Edit zone DNS" template, restricted to the one zone). Used once by the installer to create the `deploy.`/`mail.` records, and again later in the setup wizard so Shipway can manage project DNS records going forward.
4. **An email address** for Let's Encrypt renewal notices (the ACME account email).
5. The server's **public IP address**.

## Running the installer

Clone the repository onto the server (or copy it over) and run the installer as root:

```bash
git clone <this repo> shipway
cd shipway
sudo ./setup/install.sh
```

It asks four questions (or reads them from `SHIPWAY_BASE_DOMAIN`, `SHIPWAY_SERVER_IP`, `SHIPWAY_CF_API_TOKEN`, `SHIPWAY_ACME_EMAIL` for a non-interactive run):

- **Base domain** - e.g. `intcore.dev`. Every project gets `<slug>.<base-domain>`; the dashboard itself lives at `deploy.<base-domain>`.
- **Server public IP** - used for the DNS `A` records.
- **Cloudflare API token** - the one from the prerequisites above.
- **ACME contact email** - passed to Let's Encrypt.

From there it runs unattended. In order, it:

1. Installs nginx, PHP 8.1 through 8.4 (via the `ondrej/php` PPA, with the extensions Laravel apps typically need), Composer, MySQL, PostgreSQL, and Redis.
2. Installs Node 18, 20, and 22 side by side under `/opt/node/<version>`, verifying each download's checksum against the official `SHASUMS256.txt` before extracting it.
3. Installs Mailpit (the shared catch-all SMTP inbox) as its own systemd service.
4. Installs certbot and requests one wildcard certificate for `*.<base-domain>` via Cloudflare DNS-01 (no port 80 verification needed, so this works even before the dashboard is live).
5. Creates the `deployer` system user, its directories, the `shipway-sysops` root helper, and a sudoers policy that lets `deployer` run exactly the handful of commands Shipway needs (reload nginx/php-fpm, manage its own `shipway-*` systemd units) and nothing else.
6. Creates a `shipway_admin` MySQL user and Postgres role with random passwords, and sets a random Redis password.
7. Builds Shipway itself into `/opt/shipway` and starts it as `shipway.service`.
8. Renders the nginx vhosts for the dashboard and Mailpit's web UI, and reloads nginx.
9. Creates the `deploy.` and `mail.` DNS records at Cloudflare.

It finishes by printing `https://deploy.<base-domain>` - that is the dashboard.

Re-running `install.sh` is safe: every step checks whether its work is already done before repeating it, and generated passwords are cached in `/root/.shipway-install-secrets` so a re-run never rotates a credential something else already depends on.

## First-run setup wizard

The first time you open `https://deploy.<base-domain>`, Shipway walks you through:

1. **Create the first admin account** (name, email, password).
2. **Server settings** - `base_domain`, `server_ip`, and `acme_email` are already filled in (the installer wrote them into a one-time bootstrap file that Shipway imports on its first boot and then deletes). Add the **Cloudflare API token** and **zone ID** here too: the installer only used the token transiently to create its own two DNS records, so Shipway needs it again, stored this time, to manage each new project's subdomain record.
3. **Cloudflare token test** - confirms the token can read/write the zone before you rely on it.
4. **GitHub App** - click through GitHub's App Manifest flow (a button here redirects to GitHub with a pre-filled manifest: `contents:read` + `metadata:read` permissions, the `push` webhook event, and the webhook URL already pointed at `https://deploy.<base-domain>/api/webhooks/github`). GitHub redirects back with a code that Shipway exchanges automatically for the app ID, private key, and webhook secret. A manual paste-the-fields fallback is on the same page if you'd rather create the App yourself.
5. Once the App is created, **install it on your GitHub org** (or the specific repos you want Shipway to deploy) from GitHub's own "Install App" page. Shipway stores the installation ID once you come back.

From there, **Projects > New** lists the installation's repositories and lets you pick a branch, runtime, and commands.

## Where things live on disk

| Path | What |
|---|---|
| `/opt/shipway` | The Shipway tool itself (this repo, built) |
| `/var/lib/shipway/shipway.db` | Shipway's own SQLite database |
| `/var/lib/shipway/secret.key` | Encryption key for env vars/secrets at rest (mode 0600) |
| `/var/deploy/apps/<slug>/` | One project's releases: `repo/` (bare git mirror), `releases/<timestamp>/`, `shared/` (persists across releases, including `.env`), `current` (symlink to the live release) |
| `/var/deploy/logs/<slug>/<deployment-id>.log` | Per-deploy build/activate logs |
| `/opt/node/<18\|20\|22>` | Node runtimes, one directory per major version |
| `/etc/nginx/sites-available/shipway-*.conf` | Project (and the dashboard/Mailpit) vhosts, symlinked into `sites-enabled` |
| `/etc/systemd/system/shipway-*.service` | Per-project app/worker units |
| `/etc/systemd/system/shipway.service` | Shipway itself |
| `/usr/local/bin/shipway-sysops` | The whitelisted root helper the `deployer` user's sudo rules allow |
| `/etc/letsencrypt/live/<base-domain>/` | The wildcard certificate |

## Updating

```bash
sudo /opt/shipway/setup/update.sh
```

Pulls the latest commit as `deployer`, rebuilds, and restarts `shipway.service`. Database migrations run automatically on the next startup, no separate step needed.

## Troubleshooting

**A project's site is down or a deploy failed to activate.**
Check the deploy's log first, either in the dashboard (Project > Deployments > that deploy) or directly at `/var/deploy/logs/<slug>/<deployment-id>.log`. A failed deploy never leaves a working site broken: failures before activation are discarded, failures after activation can be rolled back from the same screen.

**nginx won't reload, or a new project's vhost didn't take effect.**
Run `sudo nginx -t` to see the exact config error. Shipway itself runs this check before ever reloading nginx, so a broken vhost is rejected (and rolled back) rather than taking the whole server offline; if you're troubleshooting a vhost by hand, this is the same check.

**Shipway itself won't start, or the dashboard is unreachable.**
```bash
sudo systemctl status shipway
sudo journalctl -u shipway -n 200
```
Also worth checking: `sudo systemctl status nginx` and `curl -v http://127.0.0.1:8090/api/health` from the server (Shipway listens only on localhost; nginx is what terminates TLS and proxies to it).

**A worker keeps restarting, or its output isn't what you expect.**
Worker logs go through the systemd journal like any other unit: `sudo journalctl -u shipway-worker-<slug>-<name>@1 -n 200`, or use the log tail in the dashboard's Workers tab.

**Certificate renewal.**
Certbot's systemd timer handles renewal on its own. `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh` reloads nginx automatically after a successful renewal, so no manual step is needed; `sudo certbot renew --dry-run` is the way to test it without waiting for the real expiry window.

**Database credentials.**
Reveal a project's database credentials from the dashboard (Databases > that database > reveal). The `shipway_admin` MySQL/Postgres credentials the installer created live only in Shipway's settings after the one-time bootstrap import; they are not written anywhere else on disk.
