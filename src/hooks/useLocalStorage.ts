'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * useState persisted to localStorage. Renders `initial` on the server and on
 * the first client render (no hydration mismatch), then loads the stored value.
 */
export function useLocalStorage<T>(key: string, initial: T): [T, (value: T | ((prev: T) => T)) => void, boolean] {
  const [value, setValue] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch {
      /* unavailable or corrupt – keep the default */
    }
    setLoaded(true);
  }, [key]);

  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* quota / private mode */
    }
  }, [key, value, loaded]);

  const update = useCallback((next: T | ((prev: T) => T)) => setValue(next), []);
  return [value, update, loaded];
}
