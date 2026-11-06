'use client'

import type { FormEvent, ReactNode } from 'react'

import { DialogFooter } from '@/components/ui/dialog'

/**
 * Cuerpo y pie de un diálogo largo: el cuerpo se desplaza y los botones
 * quedan siempre a la vista (en el celular el pie no se pierde debajo del
 * teclado ni del borde). Va dentro de un `DialogContent` con
 * `className="grid-rows-[minmax(0,1fr)] gap-0 overflow-hidden p-0"`.
 *
 * Con `onSubmit` el marco es un formulario: Enter envía, y el botón
 * `type="submit"` del pie hace lo mismo.
 */
export function DialogFrame({
  children,
  notice,
  footer,
  onSubmit,
}: {
  children: ReactNode
  /** Avisos y errores: quedan fuera del desplazamiento, a la vista junto a los botones. */
  notice?: ReactNode
  footer: ReactNode
  onSubmit?: () => void
}) {
  const inner = (
    <>
      <div className="grid gap-5 overflow-y-auto overscroll-contain p-5">{children}</div>
      {notice ? <div className="grid gap-2 px-5 pb-4 empty:hidden">{notice}</div> : null}
      <DialogFooter className="m-0 rounded-b-2xl border-t bg-muted/50 p-4">{footer}</DialogFooter>
    </>
  )
  const className = 'grid min-h-0 grid-rows-[minmax(0,1fr)_auto_auto]'

  if (!onSubmit) return <div className={className}>{inner}</div>
  return (
    <form
      noValidate
      className={className}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      {inner}
    </form>
  )
}
