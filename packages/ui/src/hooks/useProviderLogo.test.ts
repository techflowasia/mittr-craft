import { afterEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { registerProductUiPlugin, resetProductUiPluginsForTests } from '@/lib/product-plugins';
import { providerLogoIds, useProviderLogo } from './useProviderLogo';

describe('provider logo aliases', () => {
    test('maps rotating exe.dev proxy provider IDs to the local exe.dev logo', () => {
        expect(providerLogoIds('exe-proxy-123')[1]).toBe('exe-dev');
    });

    test('aliases the copilot provider id to the bundled github-copilot logo', () => {
        expect(providerLogoIds('copilot')[1]).toBe('github-copilot');
    });
});

describe('remote provider logos', () => {
    afterEach(() => {
        resetProductUiPluginsForTests();
    });

    const logoOf = (providerId: string) => {
        let seen: ReturnType<typeof useProviderLogo> | null = null;
        const Probe = () => {
            seen = useProviderLogo(providerId);
            return null;
        };
        renderToStaticMarkup(createElement(Probe));
        return seen as unknown as ReturnType<typeof useProviderLogo>;
    };

    test('a provider without a bundled logo loads one from models.dev', () => {
        const logo = logoOf('no-bundled-logo-provider');
        expect(logo.hasLogo).toBe(true);
        expect(logo.src).toBe('https://models.dev/logos/no-bundled-logo-provider.svg');
    });

    test('with the remote model catalog turned off it has no logo and loads nothing', () => {
        registerProductUiPlugin({ id: 'offline', remoteModelCatalog: false });
        const logo = logoOf('no-bundled-logo-provider');
        expect(logo.hasLogo).toBe(false);
        expect(logo.src).toBeNull();
    });
});
