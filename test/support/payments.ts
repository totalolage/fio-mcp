import { Layer } from "effect";
import { PaymentControls } from "../../src/payment-controls.js";
import { PAYMENT_MIGRATIONS, PaymentLedger } from "../../src/payment-ledger.js";
import { memoryDatabase } from "./database.js";

/**
 * PaymentControls (and its PaymentLedger) on a fresh in-memory database, for
 * harnesses that build the FIO tool handlers. Needs AppConfig, FioApi,
 * Redactor and Accounts.
 */
export const memoryPaymentControls = () =>
  PaymentControls.Default.pipe(Layer.provideMerge(PaymentLedger.Default.pipe(Layer.provide(memoryDatabase(PAYMENT_MIGRATIONS)))));
