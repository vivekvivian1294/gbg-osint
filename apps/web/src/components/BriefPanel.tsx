import type { BriefItem, BriefTarget, DelayEntry } from '@gbg-osint/shared';
import { useBrief } from '../state/history';

interface BriefPanelProps {
  /** Selects the item on the map (or flies to it) when a line is clicked. */
  onShow(target: BriefTarget): void;
}

const timeFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
});

function Line({ item, onShow }: { item: BriefItem; onShow: BriefPanelProps['onShow'] }) {
  const body = (
    <>
      <span className="brief-text">{item.text}</span>
      {item.detail && (
        <span className="brief-detail" title={item.detail}>
          {item.detail}
        </span>
      )}
    </>
  );
  return (
    <li className={`brief-item brief-${item.level}`}>
      {item.target ? (
        <button type="button" onClick={() => onShow(item.target!)} title="Show on the map">
          {body}
        </button>
      ) : (
        <div>{body}</div>
      )}
    </li>
  );
}

function DelayTable({ title, rows }: { title: string; rows: readonly DelayEntry[] }) {
  if (rows.length === 0) return null;
  return (
    <table className="brief-delays">
      <caption>{title}</caption>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Late</th>
          <th scope="col">Avg</th>
          <th scope="col">Max</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <td>{r.name}</td>
            <td>
              {r.late}/{r.departures}
              {r.cancelled > 0 && <span className="brief-cancelled"> ({r.cancelled} canc.)</span>}
            </td>
            <td>+{r.meanDelayMin.toLocaleString('sv-SE')}</td>
            <td>+{r.maxDelayMin}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** "Now in Gothenburg": a rule-based summary of the live picture, refreshed every minute. */
export function BriefPanel({ onShow }: BriefPanelProps) {
  const brief = useBrief(true);
  if (!brief) return <p className="empty">Putting the brief together…</p>;
  return (
    <div className="brief">
      <p className="muted">
        Now in Gothenburg · {timeFormat.format(new Date(brief.ts))}
        {brief.historyHours < 3 && ' · statistical flags need a few hours of history'}
      </p>
      {brief.sections.length === 0 && <p className="empty">Waiting for the first data…</p>}
      {brief.sections.map((s) => (
        <section key={s.id} className="brief-section" aria-label={s.title}>
          <h3>{s.title}</h3>
          <ul>
            {s.items.map((item) => (
              <Line key={item.id} item={item} onShow={onShow} />
            ))}
          </ul>
        </section>
      ))}
      <section className="brief-section" aria-label="Transit delay index">
        <h3>Transit delay index</h3>
        <DelayTable title="Lines with late or cancelled departures" rows={brief.delays.lines} />
        <DelayTable title="Hubs (departure boards)" rows={brief.delays.hubs} />
        <p className="brief-detail">
          Departures half an hour back to an hour ahead; late means 3+ minutes. Minutes in Avg and
          Max.
        </p>
      </section>
    </div>
  );
}
