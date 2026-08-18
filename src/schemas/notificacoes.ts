import * as z from 'zod';

//Marca uma lista específica de notificações como lidas (painel do sino) ou todas de
//uma vez (tela dedicada) — nunca as duas coisas ao mesmo tempo.
export const markNotificationsReadSchema = z
  .object({
    all: z.boolean().optional(),
    //SEC-07 -> Sem teto, um array de 100 mil ids vira um WHERE id IN (...) com 100 mil
    //parâmetros — e o corpo ainda cabe folgado no limite de 32kb do express.json().
    ids: z.array(z.number().int().positive()).max(200, 'Informe no máximo 200 notificações por vez').optional(),
  })
  .refine((data) => data.all === true || (Array.isArray(data.ids) && data.ids.length > 0), {
    message: 'Informe all: true ou uma lista de ids.',
  });
