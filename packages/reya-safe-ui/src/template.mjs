const CSP_DIRECTIVES = Object.freeze([
  "default-src 'none'",
  "base-uri 'none'",
  "child-src 'none'",
  "connect-src 'none'",
  "font-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src 'none'",
  "manifest-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'self'",
  "worker-src 'none'",
  'upgrade-insecure-requests',
]);

export const META_CSP = CSP_DIRECTIVES.join('; ');
export const HEADER_CSP = [...CSP_DIRECTIVES, "frame-ancestors 'none'"].join(
  '; '
);

export const CLOUDFLARE_HEADERS = `/*
  Cache-Control: public, max-age=0, must-revalidate
  Content-Security-Policy: ${HEADER_CSP}
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
  Permissions-Policy: accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), local-fonts=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-create=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), storage-access=(), usb=(), web-share=(), xr-spatial-tracking=()
  Referrer-Policy: no-referrer
  Strict-Transport-Security: max-age=31536000
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  X-Permitted-Cross-Domain-Policies: none
  X-Robots-Tag: noindex, nofollow, noarchive
`;

export const STYLES = `:root {
  color-scheme: dark;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #08090d;
  color: #f5f7fa;
}

* {
  box-sizing: border-box;
}

body {
  min-height: 100vh;
  margin: 0;
  background:
    radial-gradient(circle at 12% 4%, rgba(104, 92, 255, 0.18), transparent 34rem),
    radial-gradient(circle at 90% 90%, rgba(46, 211, 183, 0.1), transparent 28rem),
    #08090d;
}

main {
  width: min(46rem, calc(100% - 2rem));
  margin: 0 auto;
  padding: 12vh 0 4rem;
}

.eyebrow {
  margin: 0 0 1rem;
  color: #969eae;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.panel {
  padding: clamp(1.5rem, 5vw, 3rem);
  border: 1px solid #292d37;
  border-radius: 1.25rem;
  background: rgba(17, 19, 25, 0.94);
  box-shadow: 0 2rem 7rem rgba(0, 0, 0, 0.38);
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  margin-bottom: 1.5rem;
  padding: 0.45rem 0.75rem;
  border: 1px solid #5a4420;
  border-radius: 999px;
  color: #ffd489;
  background: #211a10;
  font-size: 0.78rem;
  font-weight: 700;
}

.status::before {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: #ffb84d;
  content: "";
}

h1 {
  max-width: 15ch;
  margin: 0;
  font-size: clamp(2.25rem, 7vw, 4.6rem);
  font-weight: 650;
  letter-spacing: -0.055em;
  line-height: 0.98;
}

.summary {
  max-width: 38rem;
  margin: 1.5rem 0 0;
  color: #b7becb;
  font-size: 1.05rem;
  line-height: 1.65;
}

.facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
  margin: 2rem 0 0;
}

.fact {
  min-width: 0;
  padding: 1rem;
  border: 1px solid #292d37;
  border-radius: 0.8rem;
  background: #0d0f14;
}

.fact dt {
  margin-bottom: 0.45rem;
  color: #7f8796;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.fact dd {
  margin: 0;
  color: #e9edf3;
}

code {
  overflow-wrap: anywhere;
  color: #aeb5ff;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.78rem;
}

.boundary {
  margin: 2rem 0 0;
  padding-top: 1.25rem;
  border-top: 1px solid #292d37;
  color: #7f8796;
  font-size: 0.82rem;
  line-height: 1.55;
}

@media (max-width: 36rem) {
  main {
    padding-top: 2rem;
  }

  .facts {
    grid-template-columns: 1fr;
  }
}
`;

export function renderHtml({ buildSha, configDigest, sourceDigest }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <meta http-equiv="Content-Security-Policy" content="${META_CSP}">
    <meta name="reya-source-digest" content="${sourceDigest}">
    <meta name="reya-config-digest" content="${configDigest}">
    <title>Reya Cannon signer</title>
    <link rel="stylesheet" href="./assets/app.css">
  </head>
  <body>
    <main>
      <p class="eyebrow">Reya · Cannon</p>
      <section class="panel" aria-labelledby="release-title">
        <div class="status">Activation disabled</div>
        <h1 id="release-title">Proposal signing is not activated</h1>
        <p class="summary">
          This hardened release shell cannot stage, sign, or submit multisig transactions. The signing surface will
          remain unavailable until its Safe target, Reya-owned endpoints, and signer access policy pass activation
          review.
        </p>
        <dl class="facts">
          <div class="fact">
            <dt>Network</dt>
            <dd>Reya Network · chain 1729</dd>
          </div>
          <div class="fact">
            <dt>Release</dt>
            <dd><code>${buildSha}</code></dd>
          </div>
        </dl>
        <p class="boundary">
          No wallet code, RPC endpoint, staging API, artifact reader, Git integration, analytics, or remote runtime
          dependency is bundled in this release.
        </p>
      </section>
    </main>
  </body>
</html>
`;
}
