/**
 * Shared helper for GitHub's App manifest flow: builds a hidden POST form carrying the manifest
 * JSON and submits it, which navigates the browser to GitHub. Used by both the first-run
 * SetupWizard and the Settings > GitHub section (task 25) so the two "Create GitHub App" buttons
 * stay in lockstep.
 */
export function submitManifestForm(postUrl: string, manifestJson: string): void {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = postUrl;
  form.style.display = 'none';

  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'manifest';
  input.value = manifestJson;
  form.appendChild(input);

  document.body.appendChild(form);
  form.submit();
}
