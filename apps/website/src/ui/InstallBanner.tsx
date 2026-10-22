export const INSTALL_GUIDE_URL = "https://github.com/RECnRun/recnrun#install-the-extension";

export function InstallBanner() {
  return (
    <section class="banner" aria-labelledby="install-banner-title">
      <h2 id="install-banner-title">Install the RECnRun extension</h2>
      <p>Your recordings live in the browser extension. Install it, then reload this page.</p>
      <a class="button" href={INSTALL_GUIDE_URL}>
        How to install
      </a>
    </section>
  );
}
