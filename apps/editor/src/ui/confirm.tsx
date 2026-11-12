/** Asking before something that is hard to take back. One call site shape for the whole editor. */
import { useId } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Dialog } from './core';

export interface ConfirmOptions {
  /** What is about to happen, as a short question or statement. */
  title: string;
  /** The consequences, in a sentence or two. */
  message?: string;
  /** Label of the button that goes ahead. Default "OK". */
  confirmLabel?: string;
  /** Label of the button that backs out. Default "Cancel". */
  cancelLabel?: string;
  /** The action destroys something: the safe button is the default one. */
  danger?: boolean;
}

/**
 * Resolves true when the person chose to go ahead. Escape, the close button and a click outside
 * all back out. The dialog mounts itself, so this can be called from anywhere, commands included.
 */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let answered = false;
    const answer = (ok: boolean) => {
      if (answered) return;
      answered = true;
      root.unmount();
      host.remove();
      resolve(ok);
    };
    root.render(<ConfirmDialog {...opts} onAnswer={answer} />);
  });
}

function ConfirmDialog({
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  danger,
  onAnswer,
}: ConfirmOptions & { onAnswer: (ok: boolean) => void }) {
  const messageId = useId();
  // Enter presses the focused button: the one that goes ahead, or the safe one when going ahead
  // destroys something.
  return (
    <Dialog
      title={title}
      narrow
      describedBy={message ? messageId : undefined}
      onClose={() => onAnswer(false)}
      footer={
        <>
          <Button variant="ghost" autoFocus={!!danger} onClick={() => onAnswer(false)}>
            {cancelLabel}
          </Button>
          <Button autoFocus={!danger} variant={danger ? 'danger' : 'primary'} onClick={() => onAnswer(true)}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message && (
        <p className="dialog__message" id={messageId}>
          {message}
        </p>
      )}
    </Dialog>
  );
}
