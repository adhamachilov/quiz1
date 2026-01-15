import { dbEnabled, query } from './db.js';

export const recordPaymentIfNew = async (p: {
  telegramPaymentChargeId: string;
  providerPaymentChargeId?: string;
  userId: number;
  currency: string;
  totalAmount: number;
  invoicePayload?: string;
}): Promise<boolean> => {
  if (!dbEnabled) return true;
  try {
    const res = await query<{ telegram_payment_charge_id: string }>(
      `insert into bot_payments (
         telegram_payment_charge_id,
         provider_payment_charge_id,
         user_id,
         currency,
         total_amount,
         invoice_payload
       ) values ($1, $2, $3, $4, $5, $6)
       on conflict (telegram_payment_charge_id) do nothing
       returning telegram_payment_charge_id`,
      [
        p.telegramPaymentChargeId,
        p.providerPaymentChargeId ?? null,
        p.userId,
        p.currency,
        p.totalAmount,
        p.invoicePayload ?? null,
      ]
    );
    return (res.rowCount ?? 0) > 0;
  } catch {
    return true;
  }
};
