import { SetMetadata } from '@nestjs/common';

export const RECEIPT_HEADER_KEY = 'auth:receipt-header';

/**
 * Declares a receipt-guarded operation. When the named header is present the
 * access token, user lookup and RBAC are skipped and the handler must verify
 * the receipt itself. Without the header the route falls back to its
 * `@RequirePermission` pair, so the two decorators must be combined.
 */
export const AllowReceipt = (headerName: string) =>
  SetMetadata(RECEIPT_HEADER_KEY, headerName.trim().toLowerCase());
