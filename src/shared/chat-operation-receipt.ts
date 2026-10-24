// An opaque idempotency key, never principal or automatic-policy authority.
// Callers possessing workspace access can choose request identifiers already;
// this separate namespace lets the Hub keep account isolation without sending
// unsigned identity when private child policy trust is unavailable.
export const CHAT_OPERATION_RECEIPT_HEADER = "x-uatu-hub-operation-receipt";
export function validChatOperationReceipt(value: string): boolean {
  return /^opr_[A-Za-z0-9_-]{43}$/.test(value);
}
