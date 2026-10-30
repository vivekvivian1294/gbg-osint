import { GeocodeSchema } from '@gbg-osint/shared';
import { useId, useMemo, useRef, useState, type Ref } from 'react';
import { PLACES } from '../search/places';
import {
  geocodeUrl,
  lookupQuery,
  search,
  type EntityCandidate,
  type SearchResult,
} from '../search/search';
import { fetchJson } from '../state/api';

interface SearchBoxProps {
  inputRef: Ref<HTMLInputElement>;
  entities: readonly EntityCandidate[];
  onSelect(result: SearchResult): void;
}

const KIND_LABEL: Record<SearchResult['type'], string> = {
  coords: 'Coordinates',
  place: 'Place',
  entity: 'Live',
  lookup: 'Photon · OpenStreetMap',
  address: 'Address',
};

interface Lookup {
  query: string;
  state: 'loading' | 'done' | 'error';
  results: SearchResult[];
}

function lookupLabel(query: string, lookup: Lookup | null): string {
  if (lookup?.state === 'loading') return `Searching addresses for “${query}”…`;
  if (lookup?.state === 'error') return 'Address search is unavailable right now (try again)';
  if (lookup?.state === 'done') return `No addresses found for “${query}”`;
  return `Search addresses for “${query}”`;
}

export function SearchBox({ inputRef, entities, onSelect }: SearchBoxProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const pending = useRef<AbortController | null>(null);
  const listId = useId();
  const local = useMemo(() => search(query, PLACES, entities), [query, entities]);
  // Addresses are looked up only when asked for, as the free geocoder's fair-use policy expects.
  const lookupText = local[0]?.type === 'coords' ? undefined : lookupQuery(query);
  const current = lookup && lookup.query === lookupText ? lookup : null;
  const addresses = current?.state === 'done' ? current.results : [];
  const results: SearchResult[] = lookupText
    ? [
        ...local,
        ...(addresses.length > 0
          ? addresses
          : [
              {
                type: 'lookup' as const,
                label: lookupLabel(lookupText, current),
                query: lookupText,
              },
            ]),
      ]
    : local;
  const expanded = open && results.length > 0;

  const runLookup = (text: string) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLookup({ query: text, state: 'loading', results: [] });
    fetchJson(geocodeUrl(text), GeocodeSchema, controller.signal).then(
      (found) =>
        setLookup({
          query: text,
          state: 'done',
          results: found.results.map((r) => ({
            type: 'address',
            label: r.label,
            ...(r.detail && { detail: r.detail }),
            lon: r.lon,
            lat: r.lat,
          })),
        }),
      () => {
        if (!controller.signal.aborted) setLookup({ query: text, state: 'error', results: [] });
      },
    );
  };

  const choose = (result: SearchResult | undefined) => {
    if (!result) return;
    if (result.type === 'lookup') {
      if (current?.state !== 'loading') runLookup(result.query);
      return;
    }
    onSelect(result);
    pending.current?.abort();
    setQuery('');
    setOpen(false);
    setActive(0);
    setLookup(null);
  };

  return (
    <div className="search" role="search">
      <label className="visually-hidden" htmlFor={`${listId}-input`}>
        Search places, addresses, live objects or coordinates
      </label>
      <input
        id={`${listId}-input`}
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={expanded ? `${listId}-${active}` : undefined}
        placeholder="Search  /"
        autoComplete="off"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, results.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(results[active]);
          } else if (e.key === 'Escape') {
            setQuery('');
            setOpen(false);
            e.currentTarget.blur();
          }
        }}
      />
      {expanded && (
        <ul id={listId} role="listbox" className="search-results">
          {results.map((r, i) => (
            <li
              key={`${r.type}-${r.label}-${i}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(r);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span>{r.label}</span>
              <span className="muted">
                {r.type === 'entity'
                  ? `${KIND_LABEL.entity} · ${r.entity.kind}`
                  : r.type === 'address' && r.detail
                    ? `${KIND_LABEL.address} · ${r.detail}`
                    : KIND_LABEL[r.type]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
