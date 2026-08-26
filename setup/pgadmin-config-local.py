# Written by setup/install.sh — edits here are overwritten on the next install.
# pgAdmin loads config_local.py last, so anything set here overrides config.py.
#
# Deliberately minimal. Two things are worth recording about this deployment:
#
#   * Served under https://ship.<base-domain>/db/pgadmin/, not at a host root.
#     nginx conveys the prefix with the X-Script-Name header, which
#     pgAdmin4.py's ReverseProxied middleware reads. Nothing to set here for it.
#
#   * MASTER_PASSWORD_REQUIRED is left at its default (True) on purpose. It is
#     what encrypts any connection password a user chooses to save, and turning
#     it off to save a prompt would weaken credential storage for every server
#     added here.
SERVER_MODE = True

