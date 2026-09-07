import { createConfiguredWebAPIs } from './runtimeConfig';
import type { RuntimeAPIs } from '@mittrcraft/ui/lib/api/types';
import '@mittrcraft/ui/index.css';
import '@mittrcraft/ui/styles/fonts';

declare global {
  interface Window {
    __MITTRCRAFT_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

window.__MITTRCRAFT_RUNTIME_APIS__ = createConfiguredWebAPIs();

void import('@mittrcraft/ui/apps/renderElectronMiniChatApp')
  .then(({ renderElectronMiniChatApp }) => {
    renderElectronMiniChatApp(window.__MITTRCRAFT_RUNTIME_APIS__ ?? createConfiguredWebAPIs());
  });
