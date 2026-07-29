import { ReyaLocalPage } from '../src/ReyaLocalPage';
import {
  loadReyaLocalProfileConfig,
  ReyaLocalProfileConfig,
} from '../src/profile-config';
import { GetStaticProps } from 'next';
import Head from 'next/head';

export default function ReyaPage({
  config,
}: {
  config: ReyaLocalProfileConfig | null;
}) {
  if (!config) {
    return <main>Reya local profile is disabled.</main>;
  }

  return (
    <>
      <Head>
        <title>Reya Cannon Safe staging</title>
        <meta
          content="Local, execution-disabled Cannon Safe staging for Reya Network."
          name="description"
        />
        <meta content="noindex,nofollow,noarchive" name="robots" />
      </Head>
      <ReyaLocalPage config={config} />
    </>
  );
}

export const getStaticProps: GetStaticProps = async () => {
  if (process.env.REYA_LOCAL_PROFILE !== 'enabled') {
    return { props: { config: null } };
  }
  return {
    props: {
      config: loadReyaLocalProfileConfig(),
    },
  };
};
