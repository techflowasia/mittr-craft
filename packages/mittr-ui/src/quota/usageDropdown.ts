const ADDED_MARK = 'mittrcraft.usageDropdown.mittrAdded';

export type UsageDropdownStore<Id extends string> = {
  getState: () => { dropdownProviderIds: Id[]; loadSettings: () => Promise<void> };
  setState: (partial: { dropdownProviderIds: Id[] } | { loadSettings: () => Promise<void> }) => void;
};

export type UsageDropdownDeps = {
  persist: (ids: string[]) => Promise<void>;
  wasAdded: () => boolean;
  markAdded: () => void;
};

const withMittr = <Id extends string>(ids: Id[], mittr: Id): Id[] | null => (ids.includes(mittr) ? null : [...ids, mittr]);

export function keepMittrInUsageDropdown<Id extends string>(store: UsageDropdownStore<Id>, mittr: Id, deps: UsageDropdownDeps): void {
  const addOnce = async (): Promise<void> => {
    if (deps.wasAdded()) return;
    const next = withMittr(store.getState().dropdownProviderIds, mittr);
    if (!next) {
      deps.markAdded();
      return;
    }
    store.setState({ dropdownProviderIds: next });
    deps.markAdded();
    await deps.persist(next);
  };

  const loadSettings = store.getState().loadSettings;
  store.setState({
    loadSettings: async () => {
      const before = store.getState().dropdownProviderIds;
      await loadSettings();
      if (store.getState().dropdownProviderIds !== before) await addOnce();
    },
  });

  const initial = withMittr(store.getState().dropdownProviderIds, mittr);
  if (initial) store.setState({ dropdownProviderIds: initial });
}

export function storedAddedMark(storage: () => Storage | undefined): Pick<UsageDropdownDeps, 'wasAdded' | 'markAdded'> {
  let addedThisRun = false;
  const withStorage = <T>(apply: (store: Storage) => T, fallback: T): T => {
    try {
      const store = storage();
      return store ? apply(store) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    wasAdded: () => addedThisRun || withStorage((store) => store.getItem(ADDED_MARK) === '1', false),
    markAdded: () => {
      addedThisRun = true;
      withStorage((store) => store.setItem(ADDED_MARK, '1'), undefined);
    },
  };
}
