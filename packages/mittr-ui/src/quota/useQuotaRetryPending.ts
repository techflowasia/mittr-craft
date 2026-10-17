import React from 'react';

const retriesInFlight = new Set<string>();

export type QuotaRetryPending = {
  busy: boolean;
  run: (resend: (pending: Set<string>) => Promise<boolean>) => Promise<boolean | null>;
};

export function useQuotaRetryPending(messageId: string): QuotaRetryPending {
  const [running, setRunning] = React.useState(false);
  const run = React.useCallback(async (resend: (pending: Set<string>) => Promise<boolean>) => {
    if (retriesInFlight.has(messageId)) return null;
    setRunning(true);
    try {
      return await resend(retriesInFlight);
    } finally {
      setRunning(false);
    }
  }, [messageId]);
  return { busy: running || retriesInFlight.has(messageId), run };
}
