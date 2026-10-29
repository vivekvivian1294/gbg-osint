import { decodeLine } from '@gbg-osint/shared';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { clip, csvRows, modeOf, parseGtfs, splitCsv } from './gtfs';
import { entryLines, readEntry, zipEntries } from './zip';

/** A minimal zip archive (deflated entries, no Zip64), like GTFS feeds use. */
function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = deflateRawSync(Buffer.from(text));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.byteLength(text), 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(Buffer.byteLength(text), 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const csv = (rows: string[][]) => rows.map((r) => r.join(',')).join('\n');

/** Tram 6 east–west through the centre, a demand-responsive taxi, and a far-away bus. */
const FEED = {
  'agency.txt': csv([
    ['agency_id', 'agency_name'],
    ['A1', 'Västtrafik'],
  ]),
  'routes.txt': csv([
    ['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type'],
    ['R6', 'A1', '6', '', '900'],
    ['RT', 'A1', '7xx', '', '1501'],
    ['RB', 'A1', '500', '', '700'],
  ]),
  'trips.txt': csv([
    ['route_id', 'service_id', 'trip_id', 'direction_id', 'shape_id'],
    ['R6', '1', 'T1', '0', 'S-east'],
    ['R6', '1', 'T2', '0', 'S-east'],
    ['R6', '1', 'T3', '0', 'S-detour'],
    ['R6', '1', 'T4', '1', 'S-west'],
    ['RT', '1', 'T5', '0', 'S-taxi'],
    ['RB', '1', 'T6', '0', 'S-far'],
  ]),
  'stops.txt': csv([
    ['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'location_type', 'parent_station'],
    ['P-brunn', 'Brunnsparken', '57.7069', '11.9679', '1', ''],
    ['P-brunn-A', 'Brunnsparken', '57.7070', '11.9680', '0', 'P-brunn'],
    ['P-kort', 'Kortedala', '57.7530', '12.0280', '1', ''],
    ['P-kort-A', 'Kortedala', '57.7531', '12.0281', '0', 'P-kort'],
    ['P-far', 'Borås', '57.7210', '12.9400', '1', ''],
  ]),
  'stop_times.txt': csv([
    ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'],
    ['T1', '08:00:00', '08:00:00', 'P-brunn-A', '1'],
    ['T1', '08:20:00', '08:20:00', 'P-kort-A', '2'],
    ['T4', '09:00:00', '09:00:00', 'P-kort-A', '1'],
    ['T4', '09:20:00', '09:20:00', 'P-brunn-A', '2'],
    ['T6', '10:00:00', '10:00:00', 'P-far', '1'],
  ]),
  'shapes.txt': csv([
    ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'],
    // Out of order on purpose: points are sorted by sequence.
    ['S-east', '57.7300', '12.0000', '2'],
    ['S-east', '57.7069', '11.9679', '1'],
    ['S-east', '57.7530', '12.0280', '3'],
    ['S-detour', '57.7000', '11.9000', '1'],
    ['S-detour', '57.7530', '12.0280', '2'],
    ['S-west', '57.7530', '12.0280', '1'],
    ['S-west', '57.7300', '12.0000', '2'],
    ['S-west', '57.7069', '11.9679', '3'],
    ['S-taxi', '57.7000', '11.9500', '1'],
    ['S-taxi', '57.7100', '11.9600', '2'],
    ['S-far', '57.7210', '12.9400', '1'],
    ['S-far', '57.7300', '12.9500', '2'],
  ]),
};

describe('zip reader', () => {
  it('lists entries and reads them whole or line by line', async () => {
    const zip = makeZip({ 'a.txt': 'hello', 'b.txt': 'one\ntwo\r\nthree' });
    const entries = zipEntries(zip);
    expect([...entries.keys()]).toEqual(['a.txt', 'b.txt']);
    expect(readEntry(zip, entries.get('a.txt')!)).toBe('hello');
    const lines: string[] = [];
    for await (const line of entryLines(zip, entries.get('b.txt')!)) lines.push(line);
    expect(lines).toEqual(['one', 'two', 'three']);
    expect(() => zipEntries(Buffer.from('not a zip at all, definitely not'))).toThrow();
  });
});

describe('GTFS', () => {
  it('splits CSV rows, with and without quotes', () => {
    expect(splitCsv('a,b,,c')).toEqual(['a', 'b', '', 'c']);
    expect(splitCsv('1,"Torget, norra","say ""hi"""')).toEqual(['1', 'Torget, norra', 'say "hi"']);
    expect(csvRows('\uFEFFx,y\n1,2\n')).toEqual([{ x: '1', y: '2' }]);
  });

  it('maps basic and extended route types, leaving out demand-responsive services', () => {
    expect([0, 900, 3, 700, 4, 1000, 2, 100, 1501, 1700].map(modeOf)).toEqual([
      'tram',
      'tram',
      'bus',
      'bus',
      'ferry',
      'ferry',
      'train',
      'train',
      undefined,
      undefined,
    ]);
  });

  it('keeps the most common shape per direction near the city, with stations and their lines', async () => {
    const net = await parseGtfs(makeZip(FEED), 'TS');
    expect(net.routes.map((r) => [r.id, r.label, r.props])).toEqual([
      [
        'R6-0',
        'Tram 6 → Kortedala',
        { line: '6', mode: 'tram', towards: 'Kortedala', operator: 'Västtrafik' },
      ],
      [
        'R6-1',
        'Tram 6 → Brunnsparken',
        { line: '6', mode: 'tram', towards: 'Brunnsparken', operator: 'Västtrafik' },
      ],
    ]);
    expect(decodeLine(net.routes[0]!.line)).toEqual([
      [11.9679, 57.7069],
      [12, 57.73],
      [12.028, 57.753],
    ]);
    expect(net.stops.map((s) => [s.id, s.label, s.props])).toEqual([
      ['P-brunn', 'Brunnsparken', { lines: 'Tram 6', modes: 'tram' }],
      ['P-kort', 'Kortedala', { lines: 'Tram 6', modes: 'tram' }],
    ]);
  });

  it('cuts shapes to the area and at gaps in the data', () => {
    const inside = (n: number): [number, number] => [11.9 + n * 0.001, 57.7];
    // A 17 km straight jump, as in one regional train shape, splits the line.
    expect(clip([inside(0), inside(1), [12.2, 57.7], [12.201, 57.7], [12.202, 57.7]])).toEqual([
      [12.2, 57.7],
      [12.201, 57.7],
      [12.202, 57.7],
    ]);
    expect(clip([[13.5, 57.7], inside(0), inside(1)])).toEqual([inside(0), inside(1)]);
  });
});
