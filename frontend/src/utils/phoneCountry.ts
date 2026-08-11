import { locale } from "../i18n";

// Country calling codes (ITU E.164) mapped to ISO 3166-1 alpha-2 codes.
// NANP (+1) and +7 are disambiguated below via longer prefixes.
const CALLING_CODES: Record<string, string> = {
  "1": "US",
  "7": "RU",
  "20": "EG",
  "211": "SS",
  "212": "MA",
  "213": "DZ",
  "216": "TN",
  "218": "LY",
  "220": "GM",
  "221": "SN",
  "222": "MR",
  "223": "ML",
  "224": "GN",
  "225": "CI",
  "226": "BF",
  "227": "NE",
  "228": "TG",
  "229": "BJ",
  "230": "MU",
  "231": "LR",
  "232": "SL",
  "233": "GH",
  "234": "NG",
  "235": "TD",
  "236": "CF",
  "237": "CM",
  "238": "CV",
  "239": "ST",
  "240": "GQ",
  "241": "GA",
  "242": "CG",
  "243": "CD",
  "244": "AO",
  "245": "GW",
  "246": "IO",
  "248": "SC",
  "249": "SD",
  "250": "RW",
  "251": "ET",
  "252": "SO",
  "253": "DJ",
  "254": "KE",
  "255": "TZ",
  "256": "UG",
  "257": "BI",
  "258": "MZ",
  "260": "ZM",
  "261": "MG",
  "262": "RE",
  "263": "ZW",
  "264": "NA",
  "265": "MW",
  "266": "LS",
  "267": "BW",
  "268": "SZ",
  "269": "KM",
  "27": "ZA",
  "290": "SH",
  "291": "ER",
  "297": "AW",
  "298": "FO",
  "299": "GL",
  "30": "GR",
  "31": "NL",
  "32": "BE",
  "33": "FR",
  "34": "ES",
  "350": "GI",
  "351": "PT",
  "352": "LU",
  "353": "IE",
  "354": "IS",
  "355": "AL",
  "356": "MT",
  "357": "CY",
  "358": "FI",
  "359": "BG",
  "36": "HU",
  "370": "LT",
  "371": "LV",
  "372": "EE",
  "373": "MD",
  "374": "AM",
  "375": "BY",
  "376": "AD",
  "377": "MC",
  "378": "SM",
  "380": "UA",
  "381": "RS",
  "382": "ME",
  "383": "XK",
  "385": "HR",
  "386": "SI",
  "387": "BA",
  "389": "MK",
  "39": "IT",
  "40": "RO",
  "41": "CH",
  "420": "CZ",
  "421": "SK",
  "423": "LI",
  "43": "AT",
  "44": "GB",
  "45": "DK",
  "46": "SE",
  "47": "NO",
  "48": "PL",
  "49": "DE",
  "500": "FK",
  "501": "BZ",
  "502": "GT",
  "503": "SV",
  "504": "HN",
  "505": "NI",
  "506": "CR",
  "507": "PA",
  "508": "PM",
  "509": "HT",
  "51": "PE",
  "52": "MX",
  "53": "CU",
  "54": "AR",
  "55": "BR",
  "56": "CL",
  "57": "CO",
  "58": "VE",
  "590": "GP",
  "591": "BO",
  "592": "GY",
  "593": "EC",
  "594": "GF",
  "595": "PY",
  "596": "MQ",
  "597": "SR",
  "598": "UY",
  "599": "CW",
  "60": "MY",
  "61": "AU",
  "62": "ID",
  "63": "PH",
  "64": "NZ",
  "65": "SG",
  "66": "TH",
  "670": "TL",
  "672": "NF",
  "673": "BN",
  "674": "NR",
  "675": "PG",
  "676": "TO",
  "677": "SB",
  "678": "VU",
  "679": "FJ",
  "680": "PW",
  "681": "WF",
  "682": "CK",
  "683": "NU",
  "685": "WS",
  "686": "KI",
  "687": "NC",
  "688": "TV",
  "689": "PF",
  "690": "TK",
  "691": "FM",
  "692": "MH",
  "81": "JP",
  "82": "KR",
  "84": "VN",
  "850": "KP",
  "852": "HK",
  "853": "MO",
  "855": "KH",
  "856": "LA",
  "86": "CN",
  "880": "BD",
  "886": "TW",
  "90": "TR",
  "91": "IN",
  "92": "PK",
  "93": "AF",
  "94": "LK",
  "95": "MM",
  "960": "MV",
  "961": "LB",
  "962": "JO",
  "963": "SY",
  "964": "IQ",
  "965": "KW",
  "966": "SA",
  "967": "YE",
  "968": "OM",
  "970": "PS",
  "971": "AE",
  "972": "IL",
  "973": "BH",
  "974": "QA",
  "975": "BT",
  "976": "MN",
  "977": "NP",
  "98": "IR",
  "992": "TJ",
  "993": "TM",
  "994": "AZ",
  "995": "GE",
  "996": "KG",
  "998": "UZ",
};

// Kazakhstan shares +7 with Russia; its numbers start with 76 or 77.
for (const p of ["76", "77"]) CALLING_CODES[p] = "KZ";

// NANP (+1) area codes for countries other than the US.
const NANP_AREA_CODES: Record<string, string[]> = {
  CA: [
    "204", "226", "236", "249", "250", "263", "289", "306", "343", "354",
    "365", "367", "368", "382", "387", "403", "416", "418", "428", "431",
    "437", "438", "450", "460", "468", "474", "506", "514", "519", "548",
    "579", "581", "584", "587", "604", "613", "639", "647", "672", "683",
    "705", "709", "742", "753", "778", "780", "782", "807", "819", "825",
    "867", "873", "879", "902", "905",
  ],
  BS: ["242"],
  BB: ["246"],
  AI: ["264"],
  AG: ["268"],
  VG: ["284"],
  VI: ["340"],
  KY: ["345"],
  BM: ["441"],
  GD: ["473"],
  TC: ["649"],
  MS: ["664"],
  GU: ["671"],
  AS: ["684"],
  SX: ["721"],
  LC: ["758"],
  DM: ["767"],
  VC: ["784"],
  PR: ["787", "939"],
  DO: ["809", "829", "849"],
  JM: ["658", "876"],
  TT: ["868"],
  KN: ["869"],
};
for (const [iso, codes] of Object.entries(NANP_AREA_CODES)) {
  for (const c of codes) CALLING_CODES[`1${c}`] = iso;
}

/**
 * How many digits a number from this country carries in full, country code included -- the
 * form a number is written in when it is shared, so `8613800138000` is 13 and that is the
 * number to check against.
 *
 * A range where the country genuinely has one (mobile and landline of different lengths); a
 * country missing from here is not checked at all rather than guessed at, since refusing a
 * number that is in fact valid would be the worse failure.
 */
const TOTAL_DIGITS: Record<string, [number, number]> = {
  // East and Southeast Asia
  CN: [13, 13],
  HK: [11, 11],
  MO: [11, 11],
  TW: [12, 12],
  JP: [11, 12],
  KR: [11, 12],
  SG: [10, 10],
  MY: [11, 12],
  ID: [11, 14],
  PH: [12, 12],
  TH: [11, 11],
  VN: [11, 11],
  KH: [11, 12],
  LA: [11, 13],
  MM: [10, 12],
  BN: [10, 10],
  MN: [11, 11],
  // South Asia
  IN: [12, 12],
  PK: [12, 12],
  BD: [13, 13],
  LK: [12, 12],
  NP: [13, 13],
  MV: [10, 10],
  // NANP: one country code and a ten-digit number, wherever in it
  US: [11, 11],
  CA: [11, 11],
  PR: [11, 11],
  DO: [11, 11],
  JM: [11, 11],
  TT: [11, 11],
  BS: [11, 11],
  BB: [11, 11],
  // Europe
  GB: [11, 12],
  IE: [12, 12],
  FR: [11, 11],
  DE: [11, 14],
  IT: [11, 12],
  ES: [11, 11],
  PT: [12, 12],
  NL: [11, 11],
  BE: [10, 11],
  CH: [11, 11],
  AT: [10, 13],
  SE: [9, 11],
  NO: [10, 10],
  DK: [10, 10],
  FI: [9, 13],
  IS: [10, 10],
  PL: [11, 11],
  CZ: [12, 12],
  SK: [12, 12],
  HU: [11, 11],
  RO: [11, 11],
  BG: [11, 12],
  GR: [12, 12],
  LT: [11, 11],
  LV: [11, 11],
  EE: [10, 11],
  CY: [11, 11],
  MT: [11, 11],
  LU: [9, 12],
  RS: [11, 12],
  HR: [11, 12],
  SI: [11, 11],
  BA: [11, 11],
  MK: [11, 11],
  AL: [12, 12],
  MD: [11, 11],
  UA: [12, 12],
  BY: [12, 12],
  RU: [11, 11],
  KZ: [11, 11],
  // Caucasus and Central Asia
  AM: [11, 11],
  AZ: [12, 12],
  GE: [12, 12],
  UZ: [12, 12],
  KG: [12, 12],
  TJ: [12, 12],
  TM: [11, 11],
  // Middle East
  TR: [12, 12],
  IL: [12, 12],
  AE: [12, 12],
  SA: [12, 12],
  QA: [11, 11],
  KW: [11, 11],
  BH: [11, 11],
  OM: [11, 11],
  JO: [12, 12],
  LB: [10, 11],
  SY: [12, 12],
  YE: [12, 12],
  IQ: [13, 13],
  IR: [12, 12],
  PS: [12, 12],
  // Africa
  EG: [12, 12],
  MA: [12, 12],
  DZ: [12, 12],
  TN: [11, 11],
  ZA: [11, 11],
  NG: [13, 13],
  KE: [12, 12],
  GH: [12, 12],
  ET: [12, 12],
  TZ: [12, 12],
  UG: [12, 12],
  ZM: [12, 12],
  ZW: [12, 12],
  MZ: [12, 12],
  AO: [12, 12],
  CM: [12, 12],
  CI: [13, 13],
  SN: [12, 12],
  // Oceania and the Americas
  AU: [11, 11],
  NZ: [11, 13],
  BR: [12, 13],
  AR: [12, 13],
  MX: [12, 13],
  CL: [11, 11],
  CO: [12, 12],
  PE: [11, 11],
  VE: [12, 12],
  EC: [12, 12],
  UY: [11, 12],
  PY: [12, 12],
  BO: [11, 11],
};

export type PhoneCountry = {
  iso: string;
  flag: string;
  name: string;
};

function flagEmoji(iso: string): string {
  return iso.replace(/./g, (ch) =>
    String.fromCodePoint(0x1f1e6 + ch.charCodeAt(0) - 65),
  );
}

function countryName(iso: string, lang: string): string {
  try {
    return new Intl.DisplayNames([lang], { type: "region" }).of(iso) ?? iso;
  } catch {
    return iso;
  }
}

const cache = new Map<string, PhoneCountry | null>();

// Resolve a country from an international phone number via longest-prefix match.
// Names follow the active UI locale; results are memoised per locale.
export function phoneCountry(
  phone: string | null | undefined,
): PhoneCountry | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  const lang = locale.value;
  const key = `${lang}|${digits}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  let iso: string | undefined;
  for (let len = Math.min(4, digits.length); len >= 1; len--) {
    iso = CALLING_CODES[digits.slice(0, len)];
    if (iso) break;
  }
  const result: PhoneCountry | null = iso
    ? { iso, flag: flagEmoji(iso), name: countryName(iso, lang) }
    : null;
  cache.set(key, result);
  return result;
}

export type PhoneCheckStatus =
  /** Right length for the country it belongs to. */
  | "ok"
  /** Nothing typed yet. */
  | "empty"
  /** Not a phone number at all: too few or too many digits, wherever it is from. */
  | "malformed"
  | "tooShort"
  | "tooLong"
  /** A number, but nothing here knows how long this country's numbers are. */
  | "unverified";

export type PhoneCheck = {
  /** The digits alone: `+`, spaces, dashes and brackets removed. */
  digits: string;
  country: PhoneCountry | null;
  /** Total digits this country carries, country code included; null when not known. */
  expected: [number, number] | null;
  status: PhoneCheckStatus;
  /** Whether it is safe to send: everything but a length that contradicts the country. */
  ok: boolean;
};

/**
 * Checks a number the way a person would before sending it on: which country the code says it
 * is from, and whether it has that country's number of digits. `8613800138000` is a Chinese
 * number and China's are 13 digits, so a 12-digit one has a digit missing.
 *
 * A country with no length on record comes back `unverified` rather than refused -- the table
 * is a help, and the numbering plans it describes do change.
 */
export function checkPhoneNumber(input: string | null | undefined): PhoneCheck {
  const raw = (input ?? "").trim();
  const digits = raw.replace(/[\s\-().]/g, "").replace(/^\+/, "");
  if (!digits) return { digits: "", country: null, expected: null, status: "empty", ok: false };
  if (!/^\d{5,20}$/.test(digits)) {
    return { digits, country: null, expected: null, status: "malformed", ok: false };
  }

  const country = phoneCountry(digits);
  const expected = country ? (TOTAL_DIGITS[country.iso] ?? null) : null;
  if (!country || !expected) {
    return { digits, country, expected: null, status: "unverified", ok: true };
  }

  const [min, max] = expected;
  const status: PhoneCheckStatus =
    digits.length < min ? "tooShort" : digits.length > max ? "tooLong" : "ok";
  return { digits, country, expected, status, ok: status === "ok" };
}

/** `13`, or `11-12` where the country has both lengths -- for the message beside the field. */
export function expectedDigitsText(expected: [number, number]): string {
  const [min, max] = expected;
  return min === max ? String(min) : `${min}-${max}`;
}
