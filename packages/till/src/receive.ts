/**
 * The code a customer shows to be paid by another customer.
 *
 * It is the till's code without the reference: an ordinary Solana Pay
 * transfer request for this address and amount in the vault's token. The
 * payer's phone reads it with the same `readMerchantCode` it uses at a till,
 * because a voucher does not know what a merchant is.
 *
 * No reference, because nothing watches the chain for it: the payment
 * arrives as a voucher, and is checked offline like one.
 */
import { encodeTransferRequest, formatTokenAmount } from "@nelo/pay";

export function receiveCode(recipient: string, amount: bigint, mint: string): string {
  if (amount <= 0n) throw new Error("the amount must be more than zero");
  return encodeTransferRequest({ recipient, amount: formatTokenAmount(amount), splToken: mint, label: "Nelo" });
}
