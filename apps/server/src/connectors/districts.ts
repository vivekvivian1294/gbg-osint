import type { LonLat } from '@gbg-osint/shared';

export interface District {
  name: string;
  aliases?: readonly string[];
  at: LonLat;
}

/**
 * Centres of Göteborg's districts, for events whose text names one. Mostly the middle of the
 * SCB RegSO 2025 areas whose names contain the district (CC0); the rest from OpenStreetMap via
 * Photon (ODbL). Hisingen and "centrum" are left out: too large to stand for a place.
 */
export const DISTRICTS: readonly District[] = [
  { name: 'Inom Vallgraven', at: [11.9632, 57.7059] },
  { name: 'Nordstaden', aliases: ['Nordstan'], at: [11.9658, 57.7086] },
  { name: 'Vasastaden', at: [11.9732, 57.6979] },
  { name: 'Lorensberg', at: [11.9774, 57.6967] },
  { name: 'Heden', at: [11.9866, 57.7014] },
  { name: 'Stampen', at: [11.9823, 57.7132] },
  { name: 'Gullbergsvass', at: [11.9788, 57.7139] },
  { name: 'Haga', at: [11.9571, 57.6982] },
  { name: 'Annedal', at: [11.9584, 57.6922] },
  { name: 'Linnéstaden', at: [11.9523, 57.6944] },
  { name: 'Olivedal', at: [11.951, 57.697] },
  { name: 'Landala', at: [11.9694, 57.693] },
  { name: 'Johanneberg', at: [11.9803, 57.6901] },
  { name: 'Guldheden', at: [11.9709, 57.6838] },
  { name: 'Krokslätt', at: [11.993, 57.6842] },
  { name: 'Masthugget', at: [11.9418, 57.697] },
  { name: 'Stigberget', at: [11.9325, 57.695] },
  { name: 'Majorna', at: [11.9227, 57.6934] },
  { name: 'Kungsladugård', at: [11.9206, 57.6848] },
  { name: 'Sandarna', at: [11.9095, 57.6828] },
  { name: 'Änggården', at: [11.9474, 57.6794] },
  { name: 'Gårda', at: [11.9919, 57.7076] },
  { name: 'Bagaregården', at: [12.0161, 57.721] },
  { name: 'Olskroken', at: [11.9997, 57.7182] },
  { name: 'Redbergslid', at: [12.0087, 57.7191] },
  { name: 'Kålltorp', at: [12.0308, 57.7146] },
  { name: 'Lunden', at: [12.0129, 57.7113] },
  { name: 'Härlanda', at: [12.0157, 57.7115] },
  { name: 'Örgryte', at: [12.0037, 57.6977] },
  { name: 'Björkekärr', at: [12.0562, 57.6992] },
  { name: 'Kallebäck', at: [12.0272, 57.681] },
  { name: 'Skår', at: [12.0148, 57.6915] },
  { name: 'Kärralund', at: [12.0237, 57.6995] },
  { name: 'Överås', at: [12.004, 57.7026] },
  { name: 'Gamlestaden', aliases: ['Gamlestan', 'Gamlestads torg'], at: [12.0154, 57.7405] },
  { name: 'Kviberg', at: [12.03, 57.7392] },
  { name: 'Torpa', at: [12.0377, 57.7265] },
  { name: 'Utby', at: [12.0595, 57.7391] },
  { name: 'Kortedala', at: [12.0325, 57.7555] },
  { name: 'Bergsjön', aliases: ['Rymdtorget'], at: [12.0646, 57.7581] },
  { name: 'Hammarkullen', at: [12.0314, 57.7803] },
  { name: 'Hjällbo', at: [12.0187, 57.7678] },
  { name: 'Eriksbo', at: [12.0398, 57.7703] },
  { name: 'Angered', at: [12.0495, 57.797] },
  { name: 'Agnesberg', at: [12.0287, 57.7879] },
  { name: 'Gårdsten', at: [12.0274, 57.8051] },
  { name: 'Rannebergen', at: [12.0761, 57.8051] },
  { name: 'Lövgärdet', at: [12.0482, 57.815] },
  { name: 'Linnarhult', at: [12.0615, 57.7779] },
  { name: 'Gunnilse', at: [12.0907, 57.7863] },
  { name: 'Bergum', at: [12.1415, 57.8191] },
  { name: 'Olofstorp', at: [12.1686, 57.7986] },
  { name: 'Lindholmen', at: [11.9456, 57.7097] },
  { name: 'Eriksberg', at: [11.9127, 57.7004] },
  { name: 'Sannegården', at: [11.9243, 57.7078] },
  { name: 'Lundby', at: [11.9301, 57.715] },
  { name: 'Kvillebäcken', at: [11.9507, 57.7234] },
  { name: 'Backaplan', at: [11.9633, 57.723] },
  { name: 'Rambergsstaden', at: [11.9337, 57.716] },
  { name: 'Kyrkbyn', at: [11.9059, 57.7087] },
  { name: 'Bräcke', at: [11.9028, 57.7066] },
  { name: 'Slättadamm', at: [11.9321, 57.7315] },
  { name: 'Biskopsgården', at: [11.8802, 57.7172] },
  { name: 'Jättesten', at: [11.9045, 57.721] },
  { name: 'Länsmansgården', at: [11.8845, 57.7373] },
  { name: 'Svartedalen', at: [11.8999, 57.7312] },
  { name: 'Tolered', at: [11.9111, 57.7282] },
  { name: 'Kärrdalen', at: [11.8991, 57.7487] },
  { name: 'Backa', at: [11.9831, 57.7435] },
  { name: 'Brunnsbo', at: [11.9717, 57.734] },
  { name: 'Skälltorp', at: [11.9826, 57.7613] },
  { name: 'Tuve', at: [11.9324, 57.7531] },
  { name: 'Skogome', at: [11.9524, 57.7611] },
  { name: 'Kärra', at: [11.9865, 57.7995] },
  { name: 'Rödbo', at: [11.9273, 57.8088] },
  { name: 'Säve', at: [11.9273, 57.8088] },
  { name: 'Torslanda', at: [11.7729, 57.7062] },
  { name: 'Björlanda', at: [11.7979, 57.7597] },
  { name: 'Amhult', at: [11.7728, 57.7129] },
  { name: 'Arendal', at: [11.8343, 57.7078] },
  { name: 'Nolered', at: [11.8107, 57.7117] },
  { name: 'Hjuvik', at: [11.7351, 57.6939] },
  { name: 'Högsbo', at: [11.9447, 57.6575] },
  { name: 'Flatås', at: [11.9422, 57.6564] },
  { name: 'Kaverös', at: [11.9211, 57.6643] },
  { name: 'Högsbohöjd', at: [11.9162, 57.6727] },
  { name: 'Högsbotorp', at: [11.9305, 57.672] },
  { name: 'Frölunda', aliases: ['Västra Frölunda', 'Frölunda torg'], at: [11.9077, 57.6547] },
  { name: 'Tynnered', at: [11.8998, 57.6438] },
  { name: 'Ruddalen', at: [11.9098, 57.6638] },
  { name: 'Grimmered', at: [11.8997, 57.6711] },
  { name: 'Järnbrott', at: [11.9283, 57.6553] },
  { name: 'Tofta', at: [11.9222, 57.6506] },
  { name: 'Skattegården', at: [11.8965, 57.6525] },
  { name: 'Grevegården', at: [11.8987, 57.6473] },
  { name: 'Guldringen', at: [11.8903, 57.6573] },
  { name: 'Bratthammar', at: [11.8804, 57.6514] },
  { name: 'Ängås', at: [11.9153, 57.6441] },
  { name: 'Önnered', at: [11.8723, 57.64] },
  { name: 'Kannebäck', at: [11.9027, 57.6398] },
  { name: 'Fiskebäck', at: [11.8571, 57.6544] },
  { name: 'Tranered', at: [11.8735, 57.6671] },
  { name: 'Långedrag', at: [11.8433, 57.6716] },
  { name: 'Hagen', at: [11.885, 57.6807] },
  { name: 'Näset', at: [11.8716, 57.61] },
  { name: 'Askim', at: [11.9371, 57.634] },
  { name: 'Hovås', at: [11.9596, 57.6123] },
  { name: 'Billdal', at: [11.9315, 57.5821] },
  { name: 'Skintebo', at: [11.9184, 57.5871] },
  { name: 'Brottkärr', at: [11.924, 57.5999] },
  { name: 'Styrsö', at: [11.7821, 57.6094] },
  { name: 'Donsö', at: [11.8034, 57.6016] },
  { name: 'Vrångö', at: [11.7851, 57.5756] },
  { name: 'Brännö', at: [11.7718, 57.6438] },
  { name: 'Asperö', at: [11.8002, 57.6463] },
  { name: 'Köpstadsö', at: [11.8039, 57.6306] },
];

// Whole words only (so "Lundbyleden" isn't Lundby), allowing the genitive s ("Bergsjöns").
const PATTERNS = DISTRICTS.map((d) => ({
  district: d,
  re: new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${[d.name, ...(d.aliases ?? [])].join('|')})s?(?![\\p{L}\\p{N}])`,
    'gu',
  ),
}));

/**
 * The one district a text places itself in, or undefined when it names none or several.
 * Names after "mot" ("in the direction of") say where something is heading, not where it is.
 */
export function districtIn(text: string): District | undefined {
  const found = new Set<District>();
  for (const { district, re } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (!/(?:^|\s)mot\s+$/i.test(text.slice(Math.max(0, m.index - 5), m.index))) {
        found.add(district);
        break;
      }
    }
  }
  return found.size === 1 ? [...found][0] : undefined;
}
