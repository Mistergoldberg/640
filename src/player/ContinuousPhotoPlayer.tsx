import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Catalog } from '../types';
import { PhotoPlayer, type PhotoPlayerProps } from './PhotoPlayer';
import { PlayerYearLoader, type PlayerYear } from './playerYearLoader';

interface Props extends Omit<PhotoPlayerProps, 'yearNavigation'> {
  catalog: Catalog | null;
  onYearChange: (year: string, photoId: string) => void;
}

export function ContinuousPhotoPlayer({ catalog, onYearChange, ...props }: Props) {
  const loader = useMemo(() => new PlayerYearLoader(catalog), [catalog]);
  const [current, setCurrent] = useState<(PlayerYear & { initialIndex: number; revision: number }) | null>(null);
  const active = current ?? { year: props.scope.year, photos: props.photos, initialIndex: props.initialIndex, revision: 0 };
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const directionRef = useRef<-1 | 1>(1);
  const requestRef = useRef(0);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  const revisionRef = useRef(0);
  const activeRef = useRef(active); activeRef.current = active;
  const onChangeRef = useRef(onYearChange); onChangeRef.current = onYearChange;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; requestRef.current++; loader.dispose(); };
  }, [loader]);

  const cancel = useCallback(() => {
    requestRef.current++;
    pendingRef.current = false;
    setPending(false);
    setError(false);
  }, []);

  const prefetch = useCallback((direction: -1 | 1) => {
    const year = loader.adjacent(activeRef.current.year, direction);
    if (year) void loader.load(year).catch(() => {}); // Retain failures until deliberate retry.
  }, [loader]);

  const request = useCallback((direction: -1 | 1, retry = false) => {
    if (pendingRef.current) return;
    const year = loader.adjacent(activeRef.current.year, direction);
    if (!year) return;
    if (retry) loader.remove(year);
    const token = ++requestRef.current;
    directionRef.current = direction;
    pendingRef.current = true;
    setPending(true); setError(false);
    void loader.load(year).then(next => {
      if (!mountedRef.current || requestRef.current !== token) return;
      const initialIndex = direction === 1 ? 0 : next.photos.length - 1;
      revisionRef.current++;
      setCurrent({ ...next, initialIndex, revision: revisionRef.current });
      loader.retain(year);
      pendingRef.current = false; setPending(false);
      onChangeRef.current(year, next.photos[initialIndex].id);
    }).catch(() => {
      if (!mountedRef.current || requestRef.current !== token) return;
      pendingRef.current = false; setPending(false); setError(true);
    });
  }, [loader]);

  return <PhotoPlayer {...props}
    photos={active.photos} initialIndex={active.initialIndex} scope={{ type: 'year', year: active.year }}
    yearNavigation={{ revision: active.revision, hasNext: Boolean(loader.adjacent(active.year, 1)),
      hasPrevious: Boolean(loader.adjacent(active.year, -1)), pending, error,
      prefetch, request, cancel, retry: () => request(directionRef.current, true) }} />;
}
