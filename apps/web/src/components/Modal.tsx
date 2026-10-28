import { useEffect, useRef, type ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  title: string;
  className?: string;
  onClose(): void;
  children: ReactNode;
}

/** Native `<dialog>`: focus trapping, Esc to close and an inert backdrop come for free. */
export function Modal({ open, title, className, onClose, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = `${title.toLowerCase().replace(/\W+/g, '-')}-title`;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`modal ${className ?? ''}`}
      onClose={onClose}
      aria-labelledby={titleId}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <button type="button" onClick={onClose} aria-label={`Close ${title}`}>
          ✕
        </button>
      </header>
      {children}
    </dialog>
  );
}
