import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { checkDataBox, type FindDataBoxesQuery, findDataBoxes, getOwnerInfo } from "../../src/isds/databox.js";
import { dbStatus, fakeTransport, fixture, ok, serverError, soapFault, soapResponse } from "./fake-transport.js";

type Reply = Parameters<typeof fakeTransport>[0];

const run = <A, E, R>(effect: Effect.Effect<A, E, R>, reply: Reply) => {
  const transport = fakeTransport(reply);
  return effect.pipe(
    Effect.provide(transport.layer),
    Effect.map((result) => ({ result, requests: transport.requests })),
  );
};

/** Runs `effect` expecting failure; returns the error and what was sent. */
const runFailing = <A, E, R>(effect: Effect.Effect<A, E, R>, reply: Reply) => {
  const transport = fakeTransport(reply);
  return effect.pipe(
    Effect.provide(transport.layer),
    Effect.flip,
    Effect.map((error) => ({ error, requests: transport.requests })),
  );
};

const envelope = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`;

const nil = (name: string) => `<${name} xsi:nil="true" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>`;

const malformed = ok("<SOAP-ENV:Envelope><SOAP-ENV:Body><p:CheckDataBoxResponse>");

describe("getOwnerInfo (GetOwnerInfoFromLogin)", () => {
  it.effect("sends an empty dbDummy to the access service", () =>
    Effect.gen(function* () {
      const { requests } = yield* run(getOwnerInfo(), ok(fixture("GetOwnerInfoFromLogin.xml")));
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0]?.service, "access");
      assert.strictEqual(requests[0]?.operation, "GetOwnerInfoFromLogin");
      assert.strictEqual(
        requests[0]?.envelope,
        envelope(
          `<GetOwnerInfoFromLogin xmlns="http://isds.czechpoint.cz/v20"><dbDummy></dbDummy></GetOwnerInfoFromLogin>`,
        ),
      );
    }),
  );

  it.effect("decodes a legal person's box; nil elements are absent", () =>
    Effect.gen(function* () {
      const { result } = yield* run(getOwnerInfo(), ok(fixture("GetOwnerInfoFromLogin.xml")));
      assert.deepStrictEqual(result, {
        dbID: "abc2def",
        dbType: "PO",
        ic: "12345678",
        firmName: "Příklad & syn s.r.o.",
        adCity: "Praha",
        adStreet: "Korunní",
        adNumberInStreet: "12",
        adNumberInMunicipality: "1234",
        adZipCode: "12000",
        adState: "CZ",
        email: "podatelna@example.cz",
        identifier: "",
        dbState: 1,
        dbEffectiveOVM: false,
        dbOpenAddressing: true,
      });
    }),
  );

  it.effect("decodes a natural person's box; xs:date keeps the calendar date", () =>
    Effect.gen(function* () {
      const { result } = yield* run(getOwnerInfo(), ok(fixture("GetOwnerInfoFromLogin-person.xml")));
      assert.strictEqual(result.dbType, "FO");
      assert.strictEqual(result.pnFirstName, "Jan");
      assert.strictEqual(result.pnMiddleName, "Petr");
      assert.strictEqual(result.pnLastNameAtBirth, "Dvořák");
      assert.strictEqual(result.biDate, "1967-01-07");
      assert.isFalse("ic" in result);
      assert.isFalse("telNumber" in result);
    }),
  );

  it.effect("an unknown dbType is an invalid response", () =>
    Effect.gen(function* () {
      const xml = fixture("GetOwnerInfoFromLogin.xml").replace("<p:dbType>PO</p:dbType>", "<p:dbType>XX</p:dbType>");
      const { error } = yield* runFailing(getOwnerInfo(), ok(xml));
      assert.strictEqual(error._tag, "IsdsInvalidResponse");
    }),
  );

  it.effect("a non-success status fails with IsdsStatusError", () =>
    Effect.gen(function* () {
      const { error } = yield* runFailing(getOwnerInfo(), ok(soapResponse("GetOwnerInfoFromLogin", dbStatus("2103"))));
      assert.strictEqual(error._tag, "IsdsStatusError");
      if (error._tag === "IsdsStatusError") assert.strictEqual(error.code, "2103");
    }),
  );

  it.effect("a SOAP fault fails with IsdsSoapFault", () =>
    Effect.gen(function* () {
      const { error } = yield* runFailing(getOwnerInfo(), serverError(soapFault("SOAP-ENV:Server", "boom")));
      assert.strictEqual(error._tag, "IsdsSoapFault");
    }),
  );
});

describe("findDataBoxes (FindDataBox2)", () => {
  const poSearch: FindDataBoxesQuery = { dbType: "PO", firmName: "Novák & <syn>", adCity: "Praha", dbState: 1 };

  it.effect("sends every tDbOwnerInfoExt21 element in XSD order, nil when absent, text escaped", () =>
    Effect.gen(function* () {
      const { requests } = yield* run(findDataBoxes(poSearch), ok(fixture("FindDataBox2.xml")));
      assert.strictEqual(requests[0]?.service, "search");
      assert.strictEqual(requests[0]?.operation, "FindDataBox2");
      assert.strictEqual(
        requests[0]?.envelope,
        envelope(
          `<FindDataBox2 xmlns="http://isds.czechpoint.cz/v20"><dbOwnerInfo>` +
            nil("dbID") +
            `<dbType>PO</dbType>` +
            nil("ic") +
            nil("pnGivenNames") +
            nil("pnLastName") +
            `<firmName>Novák &amp; &lt;syn&gt;</firmName>` +
            nil("biDate") +
            nil("biCity") +
            nil("biCounty") +
            nil("biState") +
            nil("adCode") +
            `<adCity>Praha</adCity>` +
            nil("adDistrict") +
            nil("adStreet") +
            nil("adNumberInStreet") +
            nil("adNumberInMunicipality") +
            nil("adZipCode") +
            nil("adState") +
            nil("nationality") +
            nil("dbIdOVM") +
            `<dbState>1</dbState>` +
            nil("dbOpenAddressing") +
            nil("dbUpperID") +
            `</dbOwnerInfo></FindDataBox2>`,
        ),
      );
    }),
  );

  it.effect("puts the optional aifoIsds after dbID and renders booleans and dates lexically", () =>
    Effect.gen(function* () {
      const query: FindDataBoxesQuery = {
        aifoIsds: true,
        dbType: "FO",
        pnLastName: "Novák",
        biDate: "1960-12-31",
        dbOpenAddressing: false,
      };
      const { requests } = yield* run(findDataBoxes(query), ok(fixture("FindDataBox2.xml")));
      const sent = requests[0]?.envelope ?? "";
      assert.include(sent, `<dbOwnerInfo>${nil("dbID")}<aifoIsds>true</aifoIsds><dbType>FO</dbType>`);
      assert.include(sent, `<biDate>1960-12-31</biDate>`);
      assert.include(sent, `<dbOpenAddressing>false</dbOpenAddressing>`);
    }),
  );

  it.effect("decodes every result; unknown extra elements are ignored", () =>
    Effect.gen(function* () {
      const { result } = yield* run(findDataBoxes(poSearch), ok(fixture("FindDataBox2.xml")));
      assert.strictEqual(result.outcome, "complete");
      assert.isFalse(result.truncated);
      assert.strictEqual(result.boxes.length, 2);
      assert.deepStrictEqual(result.boxes[0], {
        dbID: "r3q2txd",
        aifoIsds: true,
        dbType: "PFO_DANPOR",
        ic: "12312312",
        pnGivenNames: "Jan",
        pnLastName: "Novák",
        firmName: "Ing. Novák - auditor",
        biDate: "1960-12-31",
        biState: "CZ",
        adCode: "321654",
        adCity: "Nýřany",
        adDistrict: "Olšov",
        adStreet: "Dvořákova",
        adNumberInMunicipality: "201",
        adZipCode: "33023",
        adState: "CZ",
        nationality: "CZ",
        dbState: 1,
        dbOpenAddressing: false,
      });
      assert.strictEqual(result.boxes[1]?.firmName, "Nováková & spol.");
      assert.strictEqual(result.boxes[1]?.dbState, 2);
    }),
  );

  it.effect("a single result decodes as a one-element array", () =>
    Effect.gen(function* () {
      const { result } = yield* run(findDataBoxes({ dbID: "r3q2txd" }), ok(fixture("FindDataBox2-single.xml")));
      assert.strictEqual(result.boxes.length, 1);
      assert.strictEqual(result.boxes[0]?.dbID, "r3q2txd");
    }),
  );

  it.effect("0002 (nothing matched) succeeds with no boxes", () =>
    Effect.gen(function* () {
      const { result } = yield* run(findDataBoxes(poSearch), ok(fixture("FindDataBox2-empty.xml")));
      assert.deepStrictEqual(result, { boxes: [], outcome: "empty", truncated: false });
    }),
  );

  it.effect("0003 (over the limit) succeeds with the returned boxes, flagged truncated", () =>
    Effect.gen(function* () {
      const { result } = yield* run(findDataBoxes(poSearch), ok(fixture("FindDataBox2-truncated.xml")));
      assert.strictEqual(result.outcome, "truncated");
      assert.isTrue(result.truncated);
      assert.strictEqual(result.boxes.length, 2);
    }),
  );

  it.effect("0009 (box can't receive commercial messages) succeeds as suppressed with no boxes", () =>
    Effect.gen(function* () {
      const { result } = yield* run(findDataBoxes({ dbID: "r3q2txd" }), ok(fixture("FindDataBox2-suppressed.xml")));
      assert.deepStrictEqual(result, { boxes: [], outcome: "suppressed", truncated: false });
    }),
  );

  it.effect("1109 (ambiguous for a non-OVM caller) fails with IsdsStatusError", () =>
    Effect.gen(function* () {
      const reply = ok(soapResponse("FindDataBox2", dbStatus("1109", "Parametry vyhledávání nedávají jednoznačný výsledek")));
      const { error } = yield* runFailing(findDataBoxes(poSearch), reply);
      assert.strictEqual(error._tag, "IsdsStatusError");
      if (error._tag === "IsdsStatusError") {
        assert.strictEqual(error.code, "1109");
        assert.strictEqual(error.classification, "Other");
      }
    }),
  );

  it.effect("2017 (invalid date) fails with IsdsStatusError", () =>
    Effect.gen(function* () {
      const reply = ok(soapResponse("FindDataBox2", dbStatus("2017", "Chyba v syntaxi data: 31.11.1960")));
      const { error } = yield* runFailing(findDataBoxes(poSearch), reply);
      assert.strictEqual(error._tag, "IsdsStatusError");
    }),
  );

  it.effect("an undocumented dbState in a result is an invalid response", () =>
    Effect.gen(function* () {
      const { error } = yield* runFailing(findDataBoxes(poSearch), ok(fixture("FindDataBox2-unknown-state.xml")));
      assert.strictEqual(error._tag, "IsdsInvalidResponse");
    }),
  );

  it.effect("SOAP faults and malformed XML fail without decoding", () =>
    Effect.gen(function* () {
      const fault = yield* runFailing(findDataBoxes(poSearch), serverError(soapFault("SOAP-ENV:Client", "bad")));
      assert.strictEqual(fault.error._tag, "IsdsSoapFault");
      const broken = yield* runFailing(findDataBoxes(poSearch), malformed);
      assert.strictEqual(broken.error._tag, "IsdsInvalidResponse");
    }),
  );

  it.effect("accepts the documented minimum criteria", () =>
    Effect.gen(function* () {
      const accepted: ReadonlyArray<FindDataBoxesQuery> = [
        { dbID: "r3q2txd" },
        { dbIdOVM: "00007064" },
        { ic: "12345678" },
        { dbType: "FO", pnLastName: "No" },
        { dbType: "PFO", pnLastName: "Novák", ic: "12345678" },
        { dbType: "PO_REQ", ic: "1" },
        { dbType: "OVM", firmName: "Úřad" },
        { dbType: "OVM_REQ", firmName: "Úřad" },
        { dbType: "OVM_FO", pnLastName: "Novák", pnGivenNames: "Jan" },
        { dbType: "OVM_PFO", ic: "12345678" },
        { dbType: "PFO_ADVOK", adCity: "Brno" },
      ];
      for (const query of accepted) {
        const { requests } = yield* run(findDataBoxes(query), ok(fixture("FindDataBox2-empty.xml")));
        assert.strictEqual(requests.length, 1, JSON.stringify(query));
      }
    }),
  );

  it.effect("rejects queries below the documented minimum, or malformed, before sending", () =>
    Effect.gen(function* () {
      const rejected: ReadonlyArray<FindDataBoxesQuery> = [
        {},
        { firmName: "Novák s.r.o." },
        { dbType: "FO", pnLastName: "N" },
        { dbType: "FO", firmName: "Novák" },
        { dbType: "PFO", pnLastName: "Novák" },
        { dbType: "PFO", ic: "12345678" },
        { dbType: "PO", firmName: " N " },
        { dbType: "OVM_REQ", ic: "12345678" },
        { dbType: "OVM_FO", pnLastName: "Novák" },
        { dbType: "OVM_PFO", pnGivenNames: "Jan" },
        { dbType: "PFO_ADVOK", dbState: 1 },
        { dbType: "PO", ic: "" },
        { dbID: "short" },
        { dbType: "FO", pnLastName: "Novák", biDate: "1960-11-31" },
        { dbType: "FO", pnLastName: "Nov\u0000ák" },
      ];
      for (const query of rejected) {
        const { error, requests } = yield* runFailing(findDataBoxes(query), ok(fixture("FindDataBox2-empty.xml")));
        assert.strictEqual(error._tag, "IsdsInvalidRequest", JSON.stringify(query));
        assert.strictEqual(requests.length, 0);
      }
    }),
  );
});

describe("checkDataBox (CheckDataBox)", () => {
  it.effect("sends the box ID to the search service", () =>
    Effect.gen(function* () {
      const { requests, result } = yield* run(checkDataBox({ dbID: "abc2def" }), ok(fixture("CheckDataBox.xml")));
      assert.strictEqual(requests[0]?.service, "search");
      assert.strictEqual(requests[0]?.operation, "CheckDataBox");
      assert.strictEqual(
        requests[0]?.envelope,
        envelope(`<CheckDataBox xmlns="http://isds.czechpoint.cz/v20"><dbID>abc2def</dbID></CheckDataBox>`),
      );
      assert.deepStrictEqual(result, { dbState: 1 });
    }),
  );

  it.effect("decodes every documented state", () =>
    Effect.gen(function* () {
      for (const state of [1, 2, 3, 4, 5] as const) {
        const reply = ok(soapResponse("CheckDataBox", `<dbState>${state}</dbState>${dbStatus("0000")}`));
        const { result } = yield* run(checkDataBox({ dbID: "abc2def" }), reply);
        assert.strictEqual(result.dbState, state);
      }
    }),
  );

  it.effect("5001 (no such box) fails with IsdsStatusError classified BoxNotFound", () =>
    Effect.gen(function* () {
      const { error } = yield* runFailing(checkDataBox({ dbID: "abc2def" }), ok(fixture("CheckDataBox-not-found.xml")));
      assert.strictEqual(error._tag, "IsdsStatusError");
      if (error._tag === "IsdsStatusError") {
        assert.strictEqual(error.code, "5001");
        assert.strictEqual(error.classification, "BoxNotFound");
      }
    }),
  );

  it.effect("2011 (malformed ID) fails with IsdsStatusError", () =>
    Effect.gen(function* () {
      const reply = ok(soapResponse("CheckDataBox", dbStatus("2011")));
      const { error } = yield* runFailing(checkDataBox({ dbID: "abc!def" }), reply);
      assert.strictEqual(error._tag, "IsdsStatusError");
      if (error._tag === "IsdsStatusError") assert.strictEqual(error.classification, "Other");
    }),
  );

  it.effect("an unknown, zero or missing dbState on success is an invalid response", () =>
    Effect.gen(function* () {
      const replies = [
        ok(fixture("CheckDataBox-unknown-state.xml")),
        ok(soapResponse("CheckDataBox", `<dbState>0</dbState>${dbStatus("0000")}`)),
        ok(soapResponse("CheckDataBox", dbStatus("0000"))),
      ];
      for (const reply of replies) {
        const { error } = yield* runFailing(checkDataBox({ dbID: "abc2def" }), reply);
        assert.strictEqual(error._tag, "IsdsInvalidResponse");
      }
    }),
  );

  it.effect("SOAP faults and malformed XML fail without decoding", () =>
    Effect.gen(function* () {
      const fault = yield* runFailing(checkDataBox({ dbID: "abc2def" }), serverError(soapFault("SOAP-ENV:Server", "x")));
      assert.strictEqual(fault.error._tag, "IsdsSoapFault");
      const broken = yield* runFailing(checkDataBox({ dbID: "abc2def" }), malformed);
      assert.strictEqual(broken.error._tag, "IsdsInvalidResponse");
    }),
  );

  it.effect("rejects an ID that isn't 7 characters before sending", () =>
    Effect.gen(function* () {
      const { error, requests } = yield* runFailing(checkDataBox({ dbID: "abc2de" }), ok(fixture("CheckDataBox.xml")));
      assert.strictEqual(error._tag, "IsdsInvalidRequest");
      assert.strictEqual(requests.length, 0);
    }),
  );
});
