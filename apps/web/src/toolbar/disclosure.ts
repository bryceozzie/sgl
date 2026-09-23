import { useEffect, useState } from 'preact/hooks';

/**
 * The toolbar's `<details>` disclosures (Save ▾, Documents ▾): plain buttons,
 * not an ARIA menu, which would promise arrow-key navigation they do not
 * have (Stage J fix round 1, item 10). While open, Escape closes it (focus
 * back on its summary when focus was inside) and so does a pointer-down
 * anywhere outside it. `onToggle` goes on the `<details>`; `close` closes it
 * from code.
 */
export function useDisclosure(ref: { readonly current: HTMLDetailsElement | null }, onOpen?: () => void) {
  const [open, setOpen] = useState(false);

  function close(returnFocus: boolean): void {
    const details = ref.current;
    if (details === null || !details.open) return;
    details.open = false;
    if (returnFocus) details.querySelector('summary')?.focus();
  }

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      close(ref.current?.contains(document.activeElement) ?? false);
    };
    const onPointer = (ev: PointerEvent): void => {
      if (!(ev.target instanceof Node) || ref.current?.contains(ev.target) !== true) close(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  function onToggle(ev: Event): void {
    const isOpen = (ev.currentTarget as HTMLDetailsElement).open;
    setOpen(isOpen);
    if (isOpen) onOpen?.();
  }

  return { open, onToggle, close };
}
