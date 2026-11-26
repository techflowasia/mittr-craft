import React from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { useI18n } from '@/lib/i18n'
import { sessionRetryText } from './sessionRetry.i18n'

/** Keyed by the current turn so leaving it cancels its dialog and local feedback. */
export function SessionRetryControl({ onRetry }: {
  onRetry(confirmInterrupt: () => Promise<boolean>): Promise<void>
}) {
  const { locale } = useI18n()
  const t = (key: Parameters<typeof sessionRetryText>[1]) => sessionRetryText(locale, key)
  const mounted = React.useRef(true)
  const [pending, setPending] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const [confirm, setConfirm] = React.useState(false)
  const confirmation = React.useRef<((value: boolean) => void) | null>(null)
  const settle = (value: boolean) => {
    confirmation.current?.(value)
    confirmation.current = null
    setConfirm(false)
  }
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      confirmation.current?.(false)
      confirmation.current = null
    }
  }, [])
  const run = async () => {
    if (pending) return
    setPending(true)
    setFailed(false)
    try {
      await onRetry(() => new Promise<boolean>((resolve) => {
        if (!mounted.current) { resolve(false); return }
        confirmation.current = resolve
        setConfirm(true)
      }))
    } catch {
      if (mounted.current) setFailed(true)
    } finally {
      if (mounted.current) setPending(false)
    }
  }
  return <div className="chat-message-column mt-2">
    <Button variant="outline" size="sm" disabled={pending} onClick={() => { void run() }}>{t('action')}</Button>
    <p className="mt-1 typography-meta text-muted-foreground">{t(failed ? 'failed' : 'note')}</p>
    <Dialog open={confirm} onOpenChange={(open) => { if (!open) settle(false) }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('confirmTitle')}</DialogTitle><DialogDescription>{t('confirmDescription')}</DialogDescription></DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => settle(false)}>{t('cancel')}</Button>
          <Button onClick={() => settle(true)}>{t('stopContinue')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}
