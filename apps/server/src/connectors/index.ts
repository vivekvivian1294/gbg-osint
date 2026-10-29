import type { Connector } from '../core/connector';
import { adsbFi } from './aircraft';
import { aisstreamShips } from './aisstream';
import { airportWeather, flightRoutes } from './aviation';
import { openFreeMapBuildings } from './buildings';
import { celestrak } from './celestrak';
import { elpris } from './elpris';
import { energyChartsSweden } from './energyCharts';
import { nasaGibs } from './gibs';
import { trafiklabGtfs } from './gtfs';
import { goteborgAirQuality, goteborgTraffic, goteborgWaterLevels } from './goteborg';
import { metNowcast, vivaHarbour } from './harbour';
import { krisinformation } from './krisinformation';
import { styrOchStall } from './nextbike';
import { openMeteoWind } from './openMeteo';
import { osmPois, osmWaterways } from './osm';
import { polisenEvents } from './polisen';
import { radioStations } from './radio';
import { trafikverketRailEvents, trafikverketTrainPositions } from './rail';
import { trafikverketFerries, trafikverketTravelTimes } from './roadsAndFerries';
import { osrmRoutes } from './routing';
import { rssNews } from './rss';
import { scbDistricts } from './scb';
import { bathingWaters, pollenForecast } from './seasonal';
import { sensorCommunity } from './sensorCommunity';
import { smhiForecast } from './smhiForecast';
import { smhiObservations, smhiSeaLevel } from './smhiObservations';
import { smhiRadar } from './smhiRadar';
import { smhiWarnings } from './smhiWarnings';
import { socialPosts } from './social';
import { streetPhotos } from './streetPhotos';
import { swedaviaFlights } from './swedavia';
import {
  trafikverketCameras,
  trafikverketRoadWeather,
  trafikverketSituations,
  trafikverketTrafficFlow,
  trafikverketTrains,
} from './trafikverket';
import { vasttrafikDepartures, vasttrafikVehicles } from './vasttrafik';
import { wikipediaNearby } from './wikipedia';

/** Every data source the server runs. Each connector lives in its own file next to this one. */
export const connectors: readonly Connector[] = [
  adsbFi,
  celestrak,
  styrOchStall,
  osmPois,
  osmWaterways,
  polisenEvents,
  krisinformation,
  smhiWarnings,
  rssNews,
  smhiObservations,
  smhiForecast,
  smhiSeaLevel,
  elpris,
  vasttrafikVehicles,
  vasttrafikDepartures,
  trafikverketSituations,
  trafikverketTrains,
  trafikverketCameras,
  trafikverketRoadWeather,
  trafikverketTrafficFlow,
  goteborgTraffic,
  goteborgWaterLevels,
  goteborgAirQuality,
  aisstreamShips,
  swedaviaFlights,
  smhiRadar,
  openFreeMapBuildings,
  streetPhotos,
  scbDistricts,
  energyChartsSweden,
  socialPosts,
  radioStations,
  osrmRoutes,
  trafikverketTrainPositions,
  trafikverketRailEvents,
  trafikverketFerries,
  trafikverketTravelTimes,
  airportWeather,
  flightRoutes,
  vivaHarbour,
  metNowcast,
  wikipediaNearby,
  openMeteoWind,
  sensorCommunity,
  pollenForecast,
  bathingWaters,
  nasaGibs,
  trafiklabGtfs,
];
