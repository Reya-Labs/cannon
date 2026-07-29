import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ReyaLocalPage } from './ReyaLocalPage';
import { ReyaLocalProfileConfig } from './profile-config';

declare const __REYA_LOCAL_CONFIG__: ReyaLocalProfileConfig;

const root = document.getElementById('root');
if (!root) throw new Error('REYA_LOCAL_ROOT_MISSING');

createRoot(root).render(
  <StrictMode>
    <ReyaLocalPage config={__REYA_LOCAL_CONFIG__} />
  </StrictMode>
);
