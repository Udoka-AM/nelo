/**
 * Storage for offline payments: the queue of vouchers taken and not yet paid,
 * the cached list of payers they are checked against, and double spends
 * caught. The logic is `voucherDb` in `@nelo/till`, shared with the payer
 * app, which receives from other customers the same way.
 *
 * Its own SQLite file, separate from the day-book. The day-book records money
 * that has arrived. This records money the merchant is *owed*, and mixing the
 * two in one table is how a till ends up showing takings it has not received.
 */
import * as SQLite from "expo-sqlite";
import { voucherDb, type Taken } from "@nelo/till";

const db = voucherDb(() => SQLite.openDatabaseAsync("nelo-till.db"));

export type Unbooked = Taken;

export const voucherStore = db.queue;
export const loadCache = db.loadCache;
export const saveCache = db.saveCache;
/**
 * A voucher the merchant has just handed goods over for, with what they
 * charged in their own currency: that is what the day-book shows once it
 * settles.
 */
export const addVoucher = db.add;
export const unbooked = db.unbooked;
export const markBooked = db.markBooked;
/** Every offline payment this till has taken, with what was charged for it. */
export const offlinePayments = db.taken;
/** Kept until the relayer has reported it, which freezes the payer's vault. */
export const addConflict = db.addConflict;
export const unreported = db.unreported;
export const markReported = db.markReported;
