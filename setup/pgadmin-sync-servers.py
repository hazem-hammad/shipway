#!/usr/bin/env python3
"""Registers Shipway's Postgres databases as pgAdmin server connections.

Installed by setup/install.sh at /opt/pgadmin/sync-servers.py and run as the `pgadmin` user by the
root helper (`shipway-sysops pgadmin-sync`), which is how Shipway — running as `deployer` — reaches
a config database only `pgadmin` can read. Edits here are overwritten on the next install.

Reads one JSON document on stdin:

    {"users": ["someone@example.com", ...],
     "servers": [{"name": "...", "host": "...", "port": 5432,
                  "database": "...", "username": "...", "password": "..."}],
     "serversByUser": {"someone@example.com": ["db_one", "db_two"]}}

and makes each listed user's pgAdmin account hold exactly those servers in a group named "Shipway".
`servers` is always the complete list, so this is a replace, not a merge: a database dropped in
Shipway loses its connection here on the next run. Only servers inside the Shipway group are ever
touched — anything a user added themselves is left alone.

`serversByUser` is optional and narrows one user to a subset of `servers`, by server name. It
carries Shipway's per-project access (server/src/lib/projectaccess.ts) into the console: a member
scoped to specific projects must not find every other database on the host saved in their account,
with its password already in their passfile. A user absent from this map is unscoped and gets the
whole list, which is why an instance that has never scoped anyone sends an empty map and behaves
exactly as it always did. An entry mapping to `[]` means "no databases", not "all" — it is the
scoped-to-nothing case, and is deliberately distinct from being absent.

Two details are what make the dashboard's Manage link land somewhere useful rather than on an empty
pgAdmin:

  * The password goes into a passfile in the user's own pgAdmin storage directory, referenced by the
    server's `passfile` connection parameter, so connecting prompts for nothing. It is per-user
    because pgAdmin deliberately strips file-path connection parameters from a SHARED server before
    another user connects with it (SENSITIVE_CONN_KEYS in pgadmin/browser/server_groups/servers) —
    one shared entry would prompt everyone but its owner.
  * Each server is restricted (`db_res`) to the one database it was created for, so the browser tree
    under it shows that database and nothing else. pgAdmin has no way to be sent to a database by
    URL; this is the closest thing to arriving already there.

Users are created if pgAdmin has not seen them yet, with the same webserver auth source and role
that pgAdmin's own webserver login would have given them on first visit (see
pgadmin/authenticate/webserver.py) — otherwise a user's servers would only appear on their SECOND
visit to the console, after a later sync.
"""

import json
import os
import sys
import sysconfig

# pgAdmin is importable only from its install directory, and its config module reads SERVER_MODE
# from builtins before anything else — the same dance setup.py does.
PKG_DIR = os.path.join(sysconfig.get_paths()["purelib"], "pgadmin4")
sys.path.insert(0, PKG_DIR)
os.chdir(PKG_DIR)

import builtins  # noqa: E402

builtins.SERVER_MODE = True

import config  # noqa: E402
from pgadmin import create_app  # noqa: E402
from pgadmin.model import db, Server, ServerGroup, User  # noqa: E402
from pgadmin.tools.user_management import create_user  # noqa: E402
from pgadmin.utils.constants import INTERNAL, WEBSERVER  # noqa: E402
from pgadmin.utils.paths import get_storage_directory  # noqa: E402

# The group every Shipway-managed server lives in. Servers outside it are none of this script's
# business, which is what keeps a sync from deleting connections someone added by hand.
GROUP_NAME = "Shipway"
# Name of the passfile written into each user's storage directory. Relative paths in a connection
# parameter are resolved against that directory by pgAdmin itself (utils.get_complete_file_path).
PASSFILE_NAME = ".pgpass"
# pgAdmin's "User" role — the same one its webserver login assigns to an auto-created account.
ROLE_USER = 2


def pgpass_field(value):
    """Escapes one field of a .pgpass line: `:` and `\\` are the format's only special characters."""
    return str(value).replace("\\", "\\\\").replace(":", "\\:")


def write_passfile(user, servers):
    """Writes `servers`' credentials to the user's passfile, 0600, and returns its relative path."""
    storage = get_storage_directory(user=user)
    path = os.path.join(storage, PASSFILE_NAME)
    lines = [
        ":".join(
            pgpass_field(s[key]) for key in ("host", "port", "database", "username", "password")
        )
        for s in servers
    ]
    # Written via a fresh 0600 file rather than in place: the passwords must never exist, even
    # briefly, in a file another local user could open.
    fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write("\n".join(lines) + ("\n" if lines else ""))
    os.replace(path + ".tmp", path)
    return "/" + PASSFILE_NAME


def sync_user(user, servers):
    """Replaces this user's Shipway server group with `servers`."""
    passfile = write_passfile(user, servers)

    group = ServerGroup.query.filter_by(user_id=user.id, name=GROUP_NAME).first()
    if group is None:
        group = ServerGroup(user_id=user.id, name=GROUP_NAME)
        db.session.add(group)
        db.session.commit()

    for stale in Server.query.filter_by(user_id=user.id, servergroup_id=group.id).all():
        db.session.delete(stale)

    for spec in servers:
        db.session.add(
            Server(
                user_id=user.id,
                servergroup_id=group.id,
                name=spec["name"],
                host=spec["host"],
                port=int(spec["port"]),
                maintenance_db=spec["database"],
                username=spec["username"],
                # The password lives in the passfile, so pgAdmin stores none of its own and has
                # nothing to encrypt (which under webserver auth it could not do durably anyway).
                save_password=0,
                comment="Managed by Shipway — this connection is rewritten on every sync.",
                db_res=spec["database"],
                db_res_type="databases",
                connection_params={
                    "sslmode": "prefer",
                    "connect_timeout": 10,
                    "passfile": passfile,
                },
                shared=False,
                use_ssh_tunnel=0,
                tunnel_authentication=0,
                tunnel_prompt_password=0,
            )
        )

    db.session.commit()


def ensure_users(emails):
    """Returns a User row per address, creating the ones pgAdmin has not seen yet."""
    users = []
    for email in emails:
        user = User.query.filter_by(username=email).first()
        if user is None:
            ok, msg = create_user(
                {
                    "username": email,
                    "email": email,
                    "role": ROLE_USER,
                    "active": True,
                    "auth_source": WEBSERVER,
                }
            )
            if not ok:
                print("could not create pgAdmin user %s: %s" % (email, msg), file=sys.stderr)
                continue
            user = User.query.filter_by(username=email).first()
        if user is not None:
            users.append(user)
    return users


def main():
    payload = json.load(sys.stdin)
    servers = payload.get("servers", [])
    emails = payload.get("users", [])
    servers_by_user = payload.get("serversByUser", {})

    app = create_app(config.APP_NAME + "-shipway-sync")
    with app.test_request_context():
        entitled = {user.id for user in ensure_users(emails)}

        # Every account pgAdmin knows is visited, not just the roster. One the installer created
        # (auth source `internal`) belongs to no Shipway user but is what an operator logs in with
        # directly, so it is entitled to the servers too. One left over from a Shipway user who has
        # since been deleted is not: it gets the empty list, so their connections and passfile go
        # away with their access rather than sitting there holding live passwords.
        accounts = User.query.filter_by(active=True).all()
        for user in accounts:
            allowed = user.id in entitled or user.auth_source == INTERNAL
            if not allowed:
                sync_user(user, [])
                continue
            # An operator's own `internal` account is never scoped -- it belongs to no Shipway user,
            # so there is no access rule to apply to it.
            names = servers_by_user.get(user.username)
            if names is None or user.auth_source == INTERNAL:
                sync_user(user, servers)
            else:
                allowed_names = set(names)
                sync_user(user, [s for s in servers if s["name"] in allowed_names])

    print("synced %d server(s) to %d pgAdmin account(s)" % (len(servers), len(accounts)))


if __name__ == "__main__":
    main()
