import { create } from 'zustand'

export type ToastKind = 'error' | 'info'

export interface Toast {
  id: string
  kind: ToastKind
  message: string
}

interface ToastState {
  toasts: Toast[]
  /** Shows a toast; auto-dismisses after `ttlMs` (default 7s for errors so there's time to read). */
  push: (kind: ToastKind, message: string, ttlMs?: number) => void
  dismiss: (id: string) => void
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, message, ttlMs = 7000) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }))
    if (ttlMs > 0) {
      setTimeout(() => get().dismiss(id), ttlMs)
    }
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))
