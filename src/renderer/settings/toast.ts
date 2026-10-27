import { createContext, useContext } from 'react';

/** A short confirmation at the bottom of the settings window. */
export const ToastContext = createContext<(text: string) => void>(() => undefined);

export function useToast(): (text: string) => void {
  return useContext(ToastContext);
}
