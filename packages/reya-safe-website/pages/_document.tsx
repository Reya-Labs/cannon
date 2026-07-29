import Document, { Head, Html, Main, NextScript } from 'next/document';

export default class ReyaDocument extends Document {
  render() {
    const ingressOrigin = process.env.REYA_LOCAL_INGRESS_ORIGIN;
    return (
      <Html className="dark" lang="en">
        <Head>
          <meta
            content={[
              "default-src 'none'",
              "base-uri 'none'",
              `connect-src 'self' ${ingressOrigin}`,
              "font-src 'self'",
              "form-action 'none'",
              "frame-ancestors 'none'",
              "img-src 'self' data:",
              "manifest-src 'none'",
              "object-src 'none'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
            ].join('; ')}
            httpEquiv="Content-Security-Policy"
          />
        </Head>
        <body>
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}
