import * as z from 'zod';

//RN-081 -> só estes quatro tipos, no máximo 5 MB. HEIC/HEIF, GIF e SVG ficam de
//fora de propósito (D-15): SVG é XML executável, e os outros dois o navegador não
//abre de forma confiável em todo mundo.
export const RECEIPT_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;

export const receiptIntentSchema = z.object({
  contentType: z.enum(RECEIPT_CONTENT_TYPES, { message: 'Formato não suportado. Envie JPEG, PNG, WebP ou PDF.' }),
  sizeInBytes: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024, 'O comprovante deve ter no máximo 5 MB'),
  originalName: z.string().trim().max(120).optional(),
});

//D-07/RN-082 -> a dispensa exige motivo explícito, para ficar registrada como
//dispensa e nunca disfarçada de liquidação.
export const waiveSettlementSchema = z.object({
  reason: z.string().trim().min(3, 'Explique o motivo da dispensa').max(200),
});
