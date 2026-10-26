import React from 'react';

import { claimNarrator, releaseNarrator, useTalkState } from './talkStore';

export function useNarratorClaim(): boolean {
  const id = React.useId();
  const narrator = useTalkState((state) => state.narrator);
  React.useEffect(() => {
    if (narrator === null) claimNarrator(id);
  }, [id, narrator]);
  React.useEffect(() => () => releaseNarrator(id), [id]);
  return narrator === id;
}
