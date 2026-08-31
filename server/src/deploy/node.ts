/**
 * Deploy commands for node/nextjs projects. Kept in its own dependency-free module (like the
 * Laravel commands in `laravel.ts`) so both the server defaults and the New Project form in the
 * web app can import the same strings.
 */

/**
 * `installCmd` for a node/nextjs project.
 *
 * `npm ci` is the right install for a deploy — it is reproducible and wipes `node_modules` first —
 * but it *only* works when the repo has a committed lockfile, and refuses with `EUSAGE` otherwise.
 * Plenty of app repos gitignore `package-lock.json`, and a deploy failing at the install step with
 * npm's usage text is a poor first impression of a service whose job is to build the repo it was
 * pointed at. So: `npm ci` when there is a lockfile to honour, plain `npm install` when there
 * isn't. Runs through `bash -c` (see `deploy/runshell.ts`), so the conditional is fine here.
 *
 * `--include=dev` because this is a *build* install, not a runtime one: a Next.js app keeps its
 * whole build toolchain (typescript, the postcss/tailwind plugins, the eslint config) in
 * `devDependencies`, and npm omits those whenever `NODE_ENV=production` — which a project is free
 * to set in its own env vars, since that same `.env` is what its systemd unit reads at runtime.
 * Being explicit here keeps "installs the dependencies the repo declares" from depending on an
 * unrelated env var. (Shipway no longer leaks its *own* `NODE_ENV` into the build — see
 * `buildShellEnv` in `deploy/pipeline.ts` — this covers the project setting it deliberately.)
 */
export const NODE_INSTALL_CMD =
  'if [ -f package-lock.json ]; then npm ci --include=dev; else npm install --include=dev; fi';

/** `buildCmd` for a node/nextjs project. */
export const NODE_BUILD_CMD = 'npm run build';

/** `startCmd` for a node/nextjs project — the long-running process systemd supervises. */
export const NODE_START_CMD = 'npm start';
