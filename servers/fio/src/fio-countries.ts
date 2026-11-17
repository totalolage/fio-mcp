/**
 * Country codes accepted by FIO's XML import: the `country_type` enumeration in
 * https://www.fio.cz/schema/fio_xml_type.xsd (included by importIB.xsd), in
 * schema order. Fetched 2026-10-22, SHA-256
 * e2b7e431e58836f6fa0518c7841238a612b6dd0eea34a2b484d285643d05f21e.
 * A plain ISO 3166 alpha-2 shape check is not enough: FIO rejects any code
 * outside this list (e.g. "ZZ").
 */
export const FIO_COUNTRY_CODES = [
  "AX", "AL", "DZ", "VI", "AS", "AD", "AO", "AI", "AQ", "AG", "AR", "AM", "AW", "AU", "AZ", "BS", "BH", "BD", "BB", "BE",
  "BZ", "BY", "BJ", "BM", "BT", "BO", "BQ", "BA", "BW", "BV", "BR", "IO", "VG", "BN", "BG", "BF", "BI", "TD", "CK", "CI",
  "CW", "ME", "CZ", "CN", "DK", "TL", "GP", "GF", "MQ", "RE", "DM", "DO", "DJ", "EG", "EC", "ER", "EE", "ET", "FO", "FK",
  "FJ", "PH", "FI", "FR", "TF", "PF", "GA", "GM", "GH", "GI", "GD", "GL", "GE", "GU", "GT", "GG", "GW", "GN", "GY", "HT",
  "HM", "HN", "HK", "CL", "HR", "IN", "ID", "IQ", "IR", "IE", "IS", "IT", "IL", "JM", "JP", "YE", "JE", "ZA", "JO", "GS",
  "KY", "KH", "CM", "CA", "CV", "QA", "KZ", "KE", "KI", "CC", "CO", "KM", "CD", "CG", "KR", "KP", "CR", "TO", "CU", "KW",
  "CY", "KG", "LA", "LS", "LB", "LR", "LY", "LI", "LT", "LV", "LU", "MO", "MG", "HU", "MK", "MY", "MW", "MV", "ML", "MT",
  "MA", "MH", "MU", "MR", "UM", "MX", "FM", "MD", "MC", "MN", "MS", "MZ", "MM", "NA", "NR", "DE", "NP", "WS", "NE", "NG",
  "NI", "NU", "NL", "AN", "NF", "NO", "NC", "NZ", "PS", "OM", "IM", "PK", "PW", "PA", "PG", "PY", "PE", "PN", "PL", "PR",
  "PT", "AT", "XK", "RS", "GQ", "RO", "RU", "RW", "GR", "BL", "PM", "SV", "SM", "SA", "SN", "SC", "SL", "SG", "SK", "SI",
  "SO", "AE", "MP", "LK", "CF", "SD", "SR", "SJ", "SH", "LC", "KN", "MF", "SX", "ST", "VC", "SZ", "SY", "SB", "ES", "SE",
  "CH", "TJ", "TZ", "TH", "TW", "TK", "TG", "TT", "TN", "TR", "TM", "TC", "TV", "UG", "UA", "UY", "US", "UZ", "YT", "CX",
  "VU", "VA", "GB", "VE", "VN", "TP", "WF", "ZR", "ZM", "EH", "ZW", "SS", "AF",
] as const;
