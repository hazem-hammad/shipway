# Written by setup/install.sh — edits here are overwritten on the next install.
# pgAdmin loads config_local.py last, so anything set here overrides config.py.
#
# Two things about how this is served are worth recording:
#
#   * Served under https://ship.<base-domain>/db/pgadmin/, not at a host root.
#     nginx conveys the prefix with the X-Script-Name header, which
#     pgAdmin4.py's ReverseProxied middleware reads. Nothing to set here for it.
#
#   * Reachability is already gated by nginx's auth_request against the Shipway
#     session, so anyone who gets this far is a signed-in Shipway user.
SERVER_MODE = True

# Trust the user nginx names in X-Shipway-User, which it copies out of the
# response to that same auth_request (see setup/templates/nginx-dashboard.conf,
# and /api/auth/me which sets it). pgAdmin's webserver source signs that user in
# and creates the account on first sight, so opening the console from the
# dashboard costs no second login. `internal` stays in the list as the fallback
# pgAdmin drops to when the header is absent — that is how the admin account the
# installer created (its password is in the install summary and in
# /root/.shipway-install-secrets) can still be used directly.
#
# The header cannot be spoofed by a client: nginx sets it from the SUBREQUEST's
# response headers, discarding anything of that name the browser sent.
AUTHENTICATION_SOURCES = ['webserver', 'internal']
WEBSERVER_REMOTE_USER = 'X-Shipway-User'
WEBSERVER_AUTO_CREATE_USER = True

# No master password prompt. It exists to encrypt connection passwords a user
# saves in pgAdmin, and under webserver auth there is nothing here for it to
# protect: the servers Shipway registers (setup/pgadmin-sync-servers.py) save no
# password at all, they read one from a passfile at connect time. Turning this
# off makes pgAdmin refuse to save passwords rather than store them weakly —
# `allow_save_password` goes false for exactly this combination (see
# pgadmin/browser/__init__.py) — which is the trade being made here: a server
# added by hand will ask for its password each session, and nobody is asked for
# a master password they never chose.
MASTER_PASSWORD_REQUIRED = False
