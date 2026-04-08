const defaultGeocodingUrl = "https://maps.googleapis.com/maps/api/geocode/json";
const preciseResultTypePriority = [
  "street_address",
  "premise",
  "subpremise",
  "route",
  "intersection",
  "plus_code",
  "neighborhood",
  "sublocality",
  "locality"
];

function getGeocodingConfig() {
  const apiKey = process.env.GEOCODING_API_KEY ?? process.env.SEARCH_API_KEY;
  const apiUrl = process.env.GEOCODING_API_URL ?? defaultGeocodingUrl;

  if (!apiKey) {
    throw new Error("GEOCODING_API_KEY or SEARCH_API_KEY is required.");
  }

  return { apiKey, apiUrl };
}

function getComponent(addressComponents, type) {
  return addressComponents.find((component) => component.types?.includes(type));
}

function firstComponent(addressComponents, types) {
  for (const type of types) {
    const component = getComponent(addressComponents, type);
    if (component?.long_name) {
      return component.long_name;
    }
  }

  return "";
}

function pickAreaName(addressComponents) {
  return (
    getComponent(addressComponents, "sublocality_level_1")?.long_name
    ?? getComponent(addressComponents, "sublocality")?.long_name
    ?? getComponent(addressComponents, "neighborhood")?.long_name
    ?? getComponent(addressComponents, "administrative_area_level_2")?.long_name
    ?? ""
  );
}

function normalizeLocationResult(result) {
  const components = result.address_components ?? [];
  const geometry = result.geometry?.location ?? {};

  return {
    formattedAddress: result.formatted_address ?? "",
    areaName: pickAreaName(components),
    cityName: firstComponent(components, [
      "locality",
      "postal_town",
      "administrative_area_level_3",
      "administrative_area_level_2",
      "sublocality_level_1",
      "sublocality"
    ]),
    stateName: firstComponent(components, [
      "administrative_area_level_1",
      "administrative_area_level_2"
    ]),
    countryName: firstComponent(components, ["country"]),
    pincode: getComponent(components, "postal_code")?.long_name ?? "",
    latitude: geometry.lat ?? null,
    longitude: geometry.lng ?? null,
    placeId: result.place_id ?? "",
    types: Array.isArray(result.types) ? result.types : []
  };
}

function normalizeNominatimResult(result) {
  const address = result.address ?? {};

  return {
    formattedAddress: result.display_name ?? "",
    areaName:
      address.suburb
      ?? address.neighbourhood
      ?? address.quarter
      ?? address.hamlet
      ?? "",
    cityName:
      address.city
      ?? address.town
      ?? address.village
      ?? address.county
      ?? "",
    stateName: address.state ?? "",
    countryName: address.country ?? "",
    pincode: address.postcode ?? "",
    latitude: result.lat ? Number(result.lat) : null,
    longitude: result.lon ? Number(result.lon) : null,
    placeId: result.place_id ? String(result.place_id) : "",
    types: Array.isArray(result.type) ? result.type : [result.type].filter(Boolean)
  };
}

function getPrecisionScore(result) {
  const types = Array.isArray(result.types) ? result.types : [];
  const matchedIndex = preciseResultTypePriority.findIndex((type) => types.includes(type));
  return matchedIndex === -1 ? preciseResultTypePriority.length : matchedIndex;
}

async function callGeocodingApi(params) {
  const { apiKey, apiUrl } = getGeocodingConfig();
  const url = new URL(apiUrl);
  url.searchParams.set("key", apiKey);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Geocoding API failed with status ${response.status}.`);
  }

  const payload = await response.json();
  if (payload.status !== "OK" && payload.status !== "ZERO_RESULTS") {
    throw new Error(`Geocoding API returned ${payload.status}.`);
  }

  return payload.results ?? [];
}

async function reverseGeocodeWithNominatim(lat, lng) {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("addressdetails", "1");

  const response = await fetch(url, {
    headers: {
      "User-Agent": "QuantumSEO/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Nominatim reverse geocode failed with status ${response.status}.`);
  }

  const payload = await response.json();
  return payload ? [normalizeNominatimResult(payload)] : [];
}

export async function geocodeAddress(query) {
  const results = await callGeocodingApi({ address: query });
  return results.map(normalizeLocationResult);
}

export async function reverseGeocode(lat, lng) {
  try {
    const results = await callGeocodingApi({ latlng: `${lat},${lng}` });
    const normalized = results
      .map(normalizeLocationResult)
      .sort((left, right) => getPrecisionScore(left) - getPrecisionScore(right));

    const usable = normalized.find((result) =>
      result.formattedAddress || result.areaName || result.cityName || result.stateName || result.countryName
    );

    if (usable) {
      return normalized;
    }
  } catch (error) {
    console.error("Primary reverse geocode failed, trying fallback.", error);
  }

  try {
    return await reverseGeocodeWithNominatim(lat, lng);
  } catch (fallbackError) {
    console.error("Fallback reverse geocode failed.", fallbackError);
    return [];
  }
}
