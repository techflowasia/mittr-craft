import { registerProductUiPlugin } from '../../ui/src/lib/product-plugins';
import { MittrCraftLogo } from './MittrCraftLogo';
import { MittrSignInGate } from './sign-in/MittrSignInGate';
import { strings } from './strings/en';

registerProductUiPlugin({
  id: 'mittrcraft',
  substitutions: [
    ['OpenChamber', 'MittrCraft'],
    ['OpenCode', 'MittrCraft'],
  ],
  dictionaries: { en: strings },
  logo: MittrCraftLogo,
  rootWrapper: MittrSignInGate,
});
