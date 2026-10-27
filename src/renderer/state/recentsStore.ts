import { create } from 'zustand'

export interface RecentProject {
  path: string
  name: string
  updatedAt: number
}

const STORAGE_KEY = 'freecut.recentProjects'
const MAX_RECENTS = 12

function load(): RecentProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as RecentProject[]) : []
  } catch {
    return []
  }
}

function persist(list: RecentProject[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    // localStorage unavailable (e.g. private mode) — recents just won't persist across launches.
  }
}

interface RecentsState {
  recents: RecentProject[]
  addRecent: (path: string, name: string) => void
  removeRecent: (path: string) => void
}

export const useRecentsStore = create<RecentsState>((set) => ({
  recents: load(),
  addRecent: (path, name) =>
    set((s) => {
      const next = [{ path, name, updatedAt: Date.now() }, ...s.recents.filter((r) => r.path !== path)].slice(0, MAX_RECENTS)
      persist(next)
      return { recents: next }
    }),
  removeRecent: (path) =>
    set((s) => {
      const next = s.recents.filter((r) => r.path !== path)
      persist(next)
      return { recents: next }
    })
}))
