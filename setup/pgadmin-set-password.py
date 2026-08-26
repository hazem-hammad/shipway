"""Set (and verify) the pgAdmin admin account's password.

Run as the `pgadmin` user, with the pgAdmin package directory as the working
directory:

    cd <pkg> && sudo -u pgadmin python setup/pgadmin-set-password.py <email> <password>

Why this exists instead of `setup.py update-user --password`, or relying on
setup-db's PGADMIN_SETUP_PASSWORD: neither reliably applied the password on
pgAdmin 9.17. `update-user --password` reported success and left the stored hash
untouched, so the account ended up with a password nobody knew and every login
bounced back to the login form with no error — pgAdmin's login view returns a
bare redirect when the credential check fails at that point, so the failure is
completely silent.

Flask-Security peppers the password with SECURITY_PASSWORD_SALT before hashing,
so the hash cannot be produced correctly outside the application context —
hence importing the same entry point gunicorn does and calling the framework's
own hash_password. The verify step at the end is the point of the script: it
fails loudly rather than leaving another unusable account behind.
"""
import sys

if len(sys.argv) != 2:
    print("usage: pgadmin-set-password.py <email>   (password on stdin)",
          file=sys.stderr)
    raise SystemExit(2)

email = sys.argv[1]
# Read the password from stdin rather than argv so it never appears in the
# process list, where any local user could read it with ps.
password = sys.stdin.readline().rstrip("\n")
if not password:
    print("pgadmin-set-password: no password on stdin", file=sys.stderr)
    raise SystemExit(2)

# sys.path[0] is the directory this script lives in, which is NOT pgAdmin's
# package directory — the caller cds there instead, so put the working
# directory on the path or the import below fails with ModuleNotFoundError.
import os  # noqa: E402

sys.path.insert(0, os.getcwd())

# Importing pgAdmin4 (rather than `from pgadmin import create_app`) matters:
# config.py imports pgadmin.utils, which imports pgadmin.model, so any other
# import order hits a circular import.
import pgAdmin4  # noqa: E402

app = pgAdmin4.app

with app.app_context():
    from pgadmin.model import db, User  # noqa: E402
    from flask_security.utils import hash_password, verify_password  # noqa: E402

    user = User.query.filter_by(email=email).first()
    if user is None:
        print(f"pgadmin-set-password: no such user: {email}", file=sys.stderr)
        raise SystemExit(1)

    user.password = hash_password(password)
    # A half-finished install can leave these set; clear them so the account is
    # actually usable once the password is right.
    user.login_attempts = 0
    user.locked = False
    db.session.commit()

    fresh = User.query.filter_by(email=email).first()
    if not verify_password(password, fresh.password):
        print("pgadmin-set-password: password did not verify after being set",
              file=sys.stderr)
        raise SystemExit(1)

print(f"pgadmin-set-password: password set and verified for {email}")
