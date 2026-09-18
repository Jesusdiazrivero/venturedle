/**
 * Country name → ISO-3166-1 alpha-2, used only by the `mock` LLM provider. The real providers do
 * this mapping themselves (it is one of the few things an LLM is reliably good at), so this list
 * covers the common cases and nothing more.
 */
export const COUNTRY_CODE_BY_NAME: Readonly<Record<string, string>> = {
  argentina: "AR",
  australia: "AU",
  austria: "AT",
  belgium: "BE",
  brazil: "BR",
  canada: "CA",
  chile: "CL",
  china: "CN",
  colombia: "CO",
  czechia: "CZ",
  "czech republic": "CZ",
  denmark: "DK",
  egypt: "EG",
  estonia: "EE",
  finland: "FI",
  france: "FR",
  germany: "DE",
  greece: "GR",
  "hong kong": "HK",
  hungary: "HU",
  india: "IN",
  indonesia: "ID",
  ireland: "IE",
  israel: "IL",
  italy: "IT",
  japan: "JP",
  kenya: "KE",
  lithuania: "LT",
  luxembourg: "LU",
  malaysia: "MY",
  mexico: "MX",
  netherlands: "NL",
  "the netherlands": "NL",
  "new zealand": "NZ",
  nigeria: "NG",
  norway: "NO",
  poland: "PL",
  portugal: "PT",
  romania: "RO",
  "saudi arabia": "SA",
  singapore: "SG",
  "south africa": "ZA",
  "south korea": "KR",
  spain: "ES",
  sweden: "SE",
  switzerland: "CH",
  turkey: "TR",
  "united arab emirates": "AE",
  "united kingdom": "GB",
  "united states": "US",
  "united states of america": "US",
  vietnam: "VN",
};

export function countryCodeOf(name: string | null): string | null {
  if (!name) return null;
  return COUNTRY_CODE_BY_NAME[name.trim().toLowerCase()] ?? null;
}
