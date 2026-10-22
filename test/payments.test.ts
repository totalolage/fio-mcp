import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { InvalidInput } from "../src/errors.js";
import { FIO_COUNTRY_CODES } from "../src/fio-countries.js";
import {
  buildImportXml as buildXml,
  escapeXml,
  isValidIban,
  type PaymentOrder,
  PaymentOrder as PaymentOrderSchema,
  PaymentOrders,
  summarizeOrders,
} from "../src/payments.js";

// Tool parameters are decoded strictly (unknown fields rejected), as here.
const strict = { onExcessProperty: "error" } as const;
const decodes = (schema: Schema.Top, value: unknown) =>
  Result.isSuccess(Schema.decodeUnknownResult(schema as Schema.Codec<unknown>)(value, strict));
const paymentOrderSchema = { safeParse: (value: unknown) => ({ success: decodes(PaymentOrderSchema, value) }) };
const paymentOrdersSchema = { safeParse: (value: unknown) => ({ success: decodes(PaymentOrders, value) }) };
const buildImportXml = (orders: readonly PaymentOrder[], payer: { accountNumber: string; currency?: string }) =>
  Effect.runSync(buildXml(orders, payer));

const payer = { accountNumber: "2400222222", currency: "CZK" };

const domestic = {
  type: "domestic",
  amount: 100,
  accountTo: "2212-2000000699",
  bankCode: "0300",
  ks: "0558",
  vs: "1234567890",
  ss: "1234567890",
  date: "2025-11-03",
  messageForRecipient: "Hračky pro děti",
  comment: "Toys & <games>",
  paymentReason: "110",
  paymentType: "priority",
} as const;

const euro = {
  type: "euro",
  amount: 12.5,
  currency: "EUR",
  accountTo: "DE89 3704 0044 0532 0130 00",
  bic: "COBADEFFXXX",
  date: "2025-11-03",
  benefName: "Hans Muller",
  benefCity: "Berlin",
  benefCountry: "DE",
  remittanceInfo1: "Invoice 42",
  paymentType: "instant",
} as const;

const foreign = {
  type: "foreign",
  amount: 1000,
  currency: "USD",
  accountTo: "123456789",
  bic: "CHASUS33",
  date: "2025-11-04",
  benefName: "John Smith",
  benefStreet: "1 Main St",
  benefCity: "New York",
  benefCountry: "US",
  remittanceInfo1: "Consulting",
  detailsOfCharges: "SHA",
  paymentReason: "347",
} as const;

function parseAll(orders: unknown[]): readonly PaymentOrder[] {
  return Schema.decodeUnknownSync(PaymentOrders)(orders, strict);
}

describe("payment XML", () => {
  it("escapes XML special characters", () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });

  it("builds a domestic order with elements in XSD order", () => {
    const xml = buildImportXml(parseAll([domestic]), payer);
    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Import xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.fio.cz/schema/importIB.xsd">',
        "  <Orders>",
        "    <DomesticTransaction>",
        "      <accountFrom>2400222222</accountFrom>",
        "      <currency>CZK</currency>",
        "      <amount>100.00</amount>",
        "      <accountTo>2212-2000000699</accountTo>",
        "      <bankCode>0300</bankCode>",
        "      <ks>0558</ks>",
        "      <vs>1234567890</vs>",
        "      <ss>1234567890</ss>",
        "      <date>2025-11-03</date>",
        "      <messageForRecipient>Hračky pro děti</messageForRecipient>",
        "      <comment>Toys &amp; &lt;games&gt;</comment>",
        "      <paymentReason>110</paymentReason>",
        "      <paymentType>431005</paymentType>",
        "    </DomesticTransaction>",
        "  </Orders>",
        "</Import>",
        "",
      ].join("\n"),
    );
  });

  it("builds a euro order with a normalised IBAN and mapped payment type", () => {
    const xml = buildImportXml(parseAll([euro]), payer);
    expect(xml).toContain(
      [
        "    <T2Transaction>",
        "      <accountFrom>2400222222</accountFrom>",
        "      <currency>EUR</currency>",
        "      <amount>12.50</amount>",
        "      <accountTo>DE89370400440532013000</accountTo>",
        "      <bic>COBADEFFXXX</bic>",
        "      <date>2025-11-03</date>",
        "      <benefName>Hans Muller</benefName>",
        "      <benefCity>Berlin</benefCity>",
        "      <benefCountry>DE</benefCountry>",
        "      <remittanceInfo1>Invoice 42</remittanceInfo1>",
        "      <paymentType>431018</paymentType>",
        "    </T2Transaction>",
      ].join("\n"),
    );
  });

  it("builds a foreign order with charges code and payment reason", () => {
    const xml = buildImportXml(parseAll([foreign]), payer);
    expect(xml).toContain(
      [
        "    <ForeignTransaction>",
        "      <accountFrom>2400222222</accountFrom>",
        "      <currency>USD</currency>",
        "      <amount>1000.00</amount>",
        "      <accountTo>123456789</accountTo>",
        "      <bic>CHASUS33</bic>",
        "      <date>2025-11-04</date>",
        "      <benefName>John Smith</benefName>",
        "      <benefStreet>1 Main St</benefStreet>",
        "      <benefCity>New York</benefCity>",
        "      <benefCountry>US</benefCountry>",
        "      <remittanceInfo1>Consulting</remittanceInfo1>",
        "      <detailsOfCharges>470503</detailsOfCharges>",
        "      <paymentReason>347</paymentReason>",
        "    </ForeignTransaction>",
      ].join("\n"),
    );
  });

  it("orders a mixed batch domestic, euro, foreign", () => {
    const xml = buildImportXml(parseAll([foreign, euro, { ...domestic, amount: 1 }, domestic]), payer);
    const tags = [...xml.matchAll(/<(DomesticTransaction|T2Transaction|ForeignTransaction)>/g)].map((m) => m[1]);
    expect(tags).toEqual(["DomesticTransaction", "DomesticTransaction", "T2Transaction", "ForeignTransaction"]);
    // Stable within a type.
    expect(xml.indexOf("<amount>1.00</amount>")).toBeLessThan(xml.indexOf("<amount>100.00</amount>"));
  });

  it("requires a currency from the order or the account", () => {
    const orders = parseAll([domestic]);
    const error = Effect.runSync(Effect.flip(buildXml(orders, { accountNumber: "2400222222" })));
    expect(error).toBeInstanceOf(InvalidInput);
    expect(error.message).toMatch(/currency is unknown/);
  });

  it("summarises totals per currency", () => {
    expect(summarizeOrders(parseAll([domestic, euro, { ...euro, amount: 0.1 }]), payer)).toEqual({
      orderCount: 3,
      counts: { domestic: 1, euro: 2, foreign: 0 },
      totalsByCurrency: { CZK: 100, EUR: 12.6 },
    });
  });
});

describe("payment validation", () => {
  const rejects = (order: unknown) => expect(paymentOrderSchema.safeParse(order).success).toBe(false);

  it("accepts each documented type", () => {
    expect(paymentOrderSchema.safeParse(domestic).success).toBe(true);
    expect(paymentOrderSchema.safeParse(euro).success).toBe(true);
    expect(paymentOrderSchema.safeParse(foreign).success).toBe(true);
  });

  it("rejects malformed domestic fields", () => {
    rejects({ ...domestic, bankCode: "300" });
    rejects({ ...domestic, accountTo: "1234567-123" });
    rejects({ ...domestic, vs: "12345678901" });
    rejects({ ...domestic, ks: "05a8" });
    rejects({ ...domestic, amount: 0 });
    rejects({ ...domestic, amount: 1.005 });
    rejects({ ...domestic, amount: 0.001 });
    // biome-ignore lint/correctness/noPrecisionLoss: the imprecise literal is the input under test
    rejects({ ...domestic, amount: 100000000000000.01 });
    rejects({ ...domestic, amount: 1e12 });
    rejects({ ...domestic, date: "2025-02-30" });
    rejects({ ...domestic, date: "0000-01-01" });
    rejects({ ...domestic, paymentType: "431001" });
    rejects({ ...domestic, paymentReason: "111" });
    rejects({ ...domestic, messageForRecipient: "line\nbreak" });
    rejects({ ...domestic, messageForRecipient: "x".repeat(141) });
    rejects({ ...domestic, unexpected: true });
  });

  it("rejects malformed euro and foreign fields", () => {
    rejects({ ...euro, accountTo: "DE89370400440532013001" });
    rejects({ ...euro, bic: "COBA" });
    rejects({ ...euro, benefName: "x".repeat(36) });
    rejects({ ...euro, benefName: undefined });
    rejects({ ...foreign, detailsOfCharges: undefined });
    rejects({ ...foreign, paymentReason: undefined });
    rejects({ ...foreign, benefCountry: "USA" });
    rejects({ ...foreign, bic: undefined });
  });

  it("accepts only countries in the XSD's country_type enumeration", () => {
    // ZZ, EU and UK are alpha-2 shaped but absent from fio_xml_type.xsd, which rejects them.
    for (const code of ["ZZ", "EU", "UK", "de"]) {
      rejects({ ...euro, benefCountry: code });
      rejects({ ...foreign, benefCountry: code });
    }
    for (const code of ["CZ", "SK", "GB", "XK"]) {
      expect(paymentOrderSchema.safeParse({ ...foreign, benefCountry: code }).success, code).toBe(true);
    }
    expect(FIO_COUNTRY_CODES).toHaveLength(253);
    expect(new Set(FIO_COUNTRY_CODES).size).toBe(253);
  });

  it("serialises amounts exactly to the cent", () => {
    for (const value of [0.01, 0.1, 0.29, 1.15, 12345.67, 999999999999.99]) {
      const [order] = parseAll([{ ...domestic, amount: value }]);
      expect(buildImportXml([order!], payer)).toContain(`<amount>${value.toFixed(2)}</amount>`);
      expect(Number(value.toFixed(2))).toBe(value);
    }
  });

  it("limits the batch size", () => {
    expect(paymentOrdersSchema.safeParse([]).success).toBe(false);
    expect(paymentOrdersSchema.safeParse(Array(101).fill(domestic)).success).toBe(false);
  });

  it("publishes descriptions and rules in the tool JSON Schema", () => {
    const document = Schema.toJsonSchemaDocument(PaymentOrders);
    const text = JSON.stringify(document);
    expect(text).toContain("PULLS money from accountTo");
    expect(text).toContain('"maxItems":100');
    expect(text).toContain("domestic");
  });

  it("validates IBAN checksums", () => {
    expect(isValidIban("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(isValidIban("GB82 WEST 1234 5698 7654 33")).toBe(false);
  });
});
