import {
  ChannelInfoSchema,
  SourceStatusSchema,
  type ChannelInfo,
  type SourceStatus,
} from '@gbg-osint/shared';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { CATALOG_POLL_MS } from '../config';
import { fetchJson } from './api';
import type { LiveClient, LiveSnapshot } from './live';

export function useLive(client: LiveClient): LiveSnapshot {
  return useSyncExternalStore(client.subscribe, client.getSnapshot);
}

export interface Catalog {
  sources: SourceStatus[];
  channels: ChannelInfo[];
  loaded: boolean;
  error: string | null;
}

const SourcesSchema = z.array(SourceStatusSchema);
const ChannelsSchema = z.array(ChannelInfoSchema);

/** Polls the server for data source health and the channels it publishes. */
export function useCatalog(intervalMs = CATALOG_POLL_MS): Catalog {
  const [catalog, setCatalog] = useState<Catalog>({
    sources: [],
    channels: [],
    loaded: false,
    error: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const [sources, channels] = await Promise.all([
          fetchJson('/api/sources', SourcesSchema, controller.signal),
          fetchJson('/api/channels', ChannelsSchema, controller.signal),
        ]);
        setCatalog({ sources, channels, loaded: true, error: null });
      } catch {
        if (controller.signal.aborted) return;
        setCatalog((c) => ({ ...c, loaded: true, error: 'Server unreachable' }));
      }
    };
    void load();
    const timer = setInterval(() => void load(), intervalMs);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [intervalMs]);

  return catalog;
}
