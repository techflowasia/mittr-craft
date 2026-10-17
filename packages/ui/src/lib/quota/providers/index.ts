import type { QuotaProviderId } from '@/types';

export interface QuotaProviderMeta {
  id: QuotaProviderId;
  name: string;
}

export const QUOTA_PROVIDERS: QuotaProviderMeta[] = [
  { id: 'claude', name: 'Claude' },
  { id: 'cline-pass', name: 'ClinePass' },
  { id: 'codex', name: 'Codex' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'github-copilot', name: 'GitHub Copilot' },
  { id: 'google', name: 'Google' },
  { id: 'kimi-for-coding', name: 'Kimi for Coding' },
  { id: 'nano-gpt', name: 'NanoGPT' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'zai-coding-plan', name: 'z.ai' },
  { id: 'zhipuai-coding-plan', name: 'Zhipu AI Coding Plan' },
  { id: 'minimax-cn-coding-plan', name: 'MiniMax Coding Plan (minimaxi.com)' },
  { id: 'minimax-coding-plan', name: 'MiniMax Coding Plan (minimax.io)' },
  { id: 'ollama-cloud', name: 'Ollama Cloud' },
  { id: 'wafer', name: 'Wafer.ai' },
  { id: 'opencode-go', name: 'OpenCode Go' },
  { id: 'deepinfra', name: 'DeepInfra' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'exe-dev', name: 'exe.dev' },
  { id: 'hyper', name: 'Charm Hyper' },
  { id: 'neuralwatt', name: 'NeuralWatt' },
  { id: 'kilo', name: 'Kilo Code' },
  { id: 'zenmux', name: 'ZenMux' },
  { id: 'xai', name: 'xAI' },
];

export function registerQuotaProvider(meta: { id: string; name: string }, options?: { first?: boolean }): void {
  if (QUOTA_PROVIDERS.some((provider) => provider.id === meta.id)) {
    return;
  }
  const entry: QuotaProviderMeta = { id: meta.id as QuotaProviderId, name: meta.name };
  if (options?.first) {
    QUOTA_PROVIDERS.unshift(entry);
  } else {
    QUOTA_PROVIDERS.push(entry);
  }
}

export function selectRegisteredQuotaProvider(id: string, select: (id: QuotaProviderId) => void): void {
  const provider = QUOTA_PROVIDERS.find((entry) => entry.id === id);
  if (provider) {
    select(provider.id);
  }
}
