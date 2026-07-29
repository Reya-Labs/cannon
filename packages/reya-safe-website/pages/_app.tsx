import type { AppProps } from 'next/app';
import '@cannon/styles/globals.css';

export default function ReyaApp({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
