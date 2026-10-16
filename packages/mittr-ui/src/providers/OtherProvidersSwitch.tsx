import React from 'react';

import { SettingsFieldRow } from '../../../ui/src/components/sections/shared/SettingsSection';
import { Switch } from '../../../ui/src/components/ui/switch';
import { useMittrT } from '../strings/mittrT';
import { useProviderLock, type SaveOutcome } from './useMittrPickerFilter';

export type OtherProvidersSwitchViewProps = {
  checked: boolean;
  known: boolean;
  saving: boolean;
  outcome: SaveOutcome | null;
  onCheckedChange: (checked: boolean) => void;
};

// The note stays visible rather than behind an info hint: it says where the
// person's prompts may go once this is on.
export function OtherProvidersSwitchView({ checked, known, saving, outcome, onCheckedChange }: OtherProvidersSwitchViewProps): React.ReactNode {
  const t = useMittrT();
  const label = t('mittr.providers.otherProviders.label');
  return (
    <div className="mb-4 space-y-1">
      <SettingsFieldRow label={label} description={t('mittr.providers.otherProviders.note')}>
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={!known || saving}
          loading={saving}
          aria-label={label}
        />
      </SettingsFieldRow>
      {outcome === 'failed' ? (
        <p role="alert" className="typography-meta text-[var(--status-error)]">{t('mittr.providers.otherProviders.saveFailed')}</p>
      ) : null}
      {outcome === 'not-applied' ? (
        <p role="status" className="typography-meta text-[var(--status-warning)]">{t('mittr.providers.otherProviders.notApplied')}</p>
      ) : null}
    </div>
  );
}

export function OtherProvidersSwitch(): React.ReactNode {
  const { snapshot, controller } = useProviderLock();
  const [saving, setSaving] = React.useState(false);
  const [outcome, setOutcome] = React.useState<SaveOutcome | null>(null);

  React.useEffect(() => {
    void controller.refresh();
  }, [controller]);

  const onCheckedChange = React.useCallback((checked: boolean) => {
    setSaving(true);
    setOutcome(null);
    void controller.save(checked).then((result) => {
      setOutcome(result);
      setSaving(false);
    });
  }, [controller]);

  return (
    <OtherProvidersSwitchView
      checked={snapshot.showOtherProviders}
      known={snapshot.known}
      saving={saving}
      outcome={outcome}
      onCheckedChange={onCheckedChange}
    />
  );
}
