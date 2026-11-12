/** Asking before something that is hard to take back. One call site shape for the whole editor. */

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

/** Resolves true when the person chose to go ahead. */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  const text = opts.message ? `${opts.title}\n\n${opts.message}` : opts.title;
  return Promise.resolve(window.confirm(text));
}
