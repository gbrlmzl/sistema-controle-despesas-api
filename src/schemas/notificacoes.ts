import * as z from 'zod';

//Marca uma lista específica de notificações como lidas (painel do sino) ou todas de
//uma vez (tela dedicada) — nunca as duas coisas ao mesmo tempo.
export const markNotificationsReadSchema = z
  .object({
    all: z.boolean().optional(),
    ids: z.array(z.number().int().positive()).optional(),
  })
  .refine((data) => data.all === true || (Array.isArray(data.ids) && data.ids.length > 0), {
    message: 'Informe all: true ou uma lista de ids.',
  });
