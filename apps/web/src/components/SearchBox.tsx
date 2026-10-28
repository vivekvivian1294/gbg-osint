import { useId, useMemo, useState, type Ref } from 'react';
import { PLACES } from '../search/places';
import { search, type EntityCandidate, type SearchResult } from '../search/search';

interface SearchBoxProps {
  inputRef: Ref<HTMLInputElement>;
  entities: readonly EntityCandidate[];
  onSelect(result: SearchResult): void;
}

const KIND_LABEL: Record<SearchResult['type'], string> = {
  coords: 'Coordinates',
  place: 'Place',
  entity: 'Live',
};

export function SearchBox({ inputRef, entities, onSelect }: SearchBoxProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const results = useMemo(() => search(query, PLACES, entities), [query, entities]);
  const expanded = open && results.length > 0;

  const choose = (result: SearchResult | undefined) => {
    if (!result) return;
    onSelect(result);
    setQuery('');
    setOpen(false);
    setActive(0);
  };

  return (
    <div className="search" role="search">
      <label className="visually-hidden" htmlFor={`${listId}-input`}>
        Search places, live objects or coordinates
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
                  : KIND_LABEL[r.type]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
