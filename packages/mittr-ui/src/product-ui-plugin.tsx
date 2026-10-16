import { registerProductUiPlugin } from '../../ui/src/lib/product-plugins';
import { MittrCraftLogo } from './MittrCraftLogo';
import { strings } from './strings/en';

registerProductUiPlugin({
  id: 'mittrcraft',
  substitutions: [
    ['OpenChamber', 'MittrCraft'],
    ['OpenCode', 'MittrCraft'],
  ],
  dictionaries: { en: strings },
  logo: MittrCraftLogo,
});
