import { useEffect, useState } from 'react';

const formatters = {
  utc: new Intl.DateTimeFormat('sv-SE', { timeZone: 'UTC', timeStyle: 'medium' }),
  local: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', timeStyle: 'medium' }),
};

export function Clock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="clock" aria-label="Current time">
      <span>
        <abbr title="Coordinated Universal Time">UTC</abbr> {formatters.utc.format(now)}
      </span>
      <span>
        <abbr title="Gothenburg local time">GBG</abbr> {formatters.local.format(now)}
      </span>
    </div>
  );
}
