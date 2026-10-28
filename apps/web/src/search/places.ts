export type PlaceKind =
  'district' | 'landmark' | 'transport' | 'port' | 'island' | 'hospital' | 'nearby';

export interface Place {
  name: string;
  /** Extra search terms, e.g. English names or abbreviations. */
  aliases?: readonly string[];
  kind: PlaceKind;
  lon: number;
  lat: number;
  /** Suggested viewing height in metres. */
  height?: number;
}

// Approximate centre points (WGS84), good enough to frame each place from above.
export const PLACES: readonly Place[] = [
  {
    name: 'Göteborg Centralstation',
    aliases: ['central station', 'centralen'],
    kind: 'transport',
    lon: 11.9733,
    lat: 57.7089,
  },
  { name: 'Nordstan', kind: 'landmark', lon: 11.9686, lat: 57.7086 },
  { name: 'Brunnsparken', kind: 'transport', lon: 11.9681, lat: 57.7067 },
  { name: 'Kungsportsplatsen', kind: 'landmark', lon: 11.9688, lat: 57.7043 },
  { name: 'Lilla Bommen', aliases: ['Läppstiftet'], kind: 'landmark', lon: 11.9672, lat: 57.7124 },
  { name: 'Göteborgsoperan', aliases: ['opera'], kind: 'landmark', lon: 11.9659, lat: 57.7114 },
  {
    name: 'Hisingsbron',
    aliases: ['hisingen bridge'],
    kind: 'landmark',
    lon: 11.9687,
    lat: 57.7149,
  },
  {
    name: 'Älvsborgsbron',
    aliases: ['alvsborg bridge'],
    kind: 'landmark',
    lon: 11.9005,
    lat: 57.6895,
    height: 4000,
  },
  { name: 'Liseberg', kind: 'landmark', lon: 11.992, lat: 57.6953 },
  { name: 'Ullevi', kind: 'landmark', lon: 11.9873, lat: 57.7058 },
  { name: 'Scandinavium', kind: 'landmark', lon: 11.9871, lat: 57.7006 },
  { name: 'Universeum', kind: 'landmark', lon: 11.9893, lat: 57.6955 },
  { name: 'Korsvägen', kind: 'transport', lon: 11.9874, lat: 57.6967 },
  { name: 'Götaplatsen', aliases: ['poseidon'], kind: 'landmark', lon: 11.9806, lat: 57.6967 },
  { name: 'Chalmers', kind: 'landmark', lon: 11.9747, lat: 57.6896 },
  { name: 'Feskekôrka', aliases: ['fish church'], kind: 'landmark', lon: 11.9586, lat: 57.7012 },
  { name: 'Haga', kind: 'district', lon: 11.9566, lat: 57.6989 },
  { name: 'Järntorget', kind: 'transport', lon: 11.9529, lat: 57.6996 },
  { name: 'Skansen Kronan', kind: 'landmark', lon: 11.9512, lat: 57.6966 },
  { name: 'Linnéstaden', aliases: ['linne'], kind: 'district', lon: 11.952, lat: 57.69 },
  { name: 'Slottsskogen', kind: 'landmark', lon: 11.9433, lat: 57.6847 },
  { name: 'Masthuggskyrkan', kind: 'landmark', lon: 11.9425, lat: 57.699 },
  { name: 'Majorna', kind: 'district', lon: 11.9214, lat: 57.6876 },
  { name: 'Lindholmen', kind: 'district', lon: 11.938, lat: 57.7065 },
  { name: 'Eriksberg', kind: 'district', lon: 11.9133, lat: 57.7032 },
  { name: 'Backaplan', kind: 'district', lon: 11.9549, lat: 57.7213 },
  { name: 'Hjalmar Brantingsplatsen', kind: 'transport', lon: 11.9659, lat: 57.7206 },
  { name: 'Biskopsgården', kind: 'district', lon: 11.8915, lat: 57.729 },
  { name: 'Gamlestaden', kind: 'district', lon: 12.005, lat: 57.729 },
  { name: 'Kortedala', kind: 'district', lon: 12.03, lat: 57.753 },
  { name: 'Bergsjön', kind: 'district', lon: 12.071, lat: 57.7529 },
  { name: 'Angered', kind: 'district', lon: 12.0473, lat: 57.7974, height: 5000 },
  { name: 'Frölunda Torg', aliases: ['frolunda'], kind: 'district', lon: 11.911, lat: 57.651 },
  { name: 'Askim', kind: 'district', lon: 11.937, lat: 57.628, height: 5000 },
  { name: 'Torslanda', kind: 'district', lon: 11.769, lat: 57.718, height: 5000 },
  {
    name: 'Delsjön',
    aliases: ['delsjoarna'],
    kind: 'landmark',
    lon: 12.0455,
    lat: 57.6917,
    height: 4000,
  },
  {
    name: 'Sahlgrenska universitetssjukhuset',
    aliases: ['sahlgrenska'],
    kind: 'hospital',
    lon: 11.9611,
    lat: 57.6829,
  },
  { name: 'Östra sjukhuset', aliases: ['ostra'], kind: 'hospital', lon: 12.0517, lat: 57.7219 },
  {
    name: 'Göteborg Landvetter Airport',
    aliases: ['GOT', 'landvetter'],
    kind: 'transport',
    lon: 12.2794,
    lat: 57.6628,
    height: 6000,
  },
  {
    name: 'Säve flygplats',
    aliases: ['GSE', 'save'],
    kind: 'transport',
    lon: 11.8704,
    lat: 57.7747,
    height: 5000,
  },
  {
    name: 'Skandiahamnen',
    aliases: ['port of gothenburg', 'container terminal'],
    kind: 'port',
    lon: 11.84,
    lat: 57.689,
    height: 5000,
  },
  { name: 'Arendal', kind: 'port', lon: 11.825, lat: 57.6935, height: 5000 },
  { name: 'Nya Varvet', kind: 'port', lon: 11.878, lat: 57.6851 },
  {
    name: 'Vinga fyr',
    aliases: ['vinga lighthouse'],
    kind: 'island',
    lon: 11.6048,
    lat: 57.6322,
    height: 5000,
  },
  { name: 'Styrsö', kind: 'island', lon: 11.78, lat: 57.6153, height: 5000 },
  { name: 'Brännö', kind: 'island', lon: 11.7713, lat: 57.6362, height: 4000 },
  { name: 'Mölndal', kind: 'nearby', lon: 12.0137, lat: 57.6555, height: 5000 },
  { name: 'Partille', kind: 'nearby', lon: 12.106, lat: 57.7395, height: 5000 },
  { name: 'Kungälv', kind: 'nearby', lon: 11.977, lat: 57.871, height: 6000 },
];
